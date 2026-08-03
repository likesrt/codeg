//! Codex "code mode" script unwrapping.
//!
//! Since codex enabled *code mode*, the model no longer emits one rollout
//! record per tool call. Every call is wrapped in a JS script handed to a
//! sandboxed runtime, and the whole script lands in the rollout as a single
//! `custom_tool_call` named `exec`:
//!
//! ```jsonc
//! {"type":"custom_tool_call","name":"exec","call_id":"call_QBS…",
//!  "input":"const r = await tools.exec_command({\n  cmd: \"git status\",\n …});\ntext(r.output);\n"}
//! {"type":"custom_tool_call_output","call_id":"call_QBS…",
//!  "output":[{"type":"input_text","text":"Script completed\nWall time 0.5 seconds\nOutput:\n"},
//!            {"type":"input_text","text":"<the real output>"}]}
//! ```
//!
//! The live path never sees this shape — codex-acp translates the app-server's
//! semantic thread items (`commandExecution` / `mcpToolCall` / `fileChange`),
//! which are already one-per-call. This module restores the same decomposition
//! for the history path by statically recovering the `tools.<name>(<args>)`
//! call sites from the script source, so every existing tool card keeps working.
//!
//! Recovery is deliberately conservative: it is a literal scanner, not a JS
//! interpreter. When *any* call site in a script fails to resolve (shorthand
//! `{cmd, workdir}` destructuring, `.map(c => tools.exec_command(c))`, template
//! interpolation, …) the whole script falls back to a single script card rather
//! than guessing.

use std::ops::Range;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

/// Codex's code-mode wrapper tool name (`custom_tool_call.name`).
pub const CODE_MODE_TOOL_NAME: &str = "exec";

/// Synthetic tool name for the fallback card that renders the raw script.
/// Deliberately NOT `exec`: the frontend's freeform matcher collapses
/// `exec(ute)?` to "bash", which would render JS as a shell command.
pub const CODEX_SCRIPT_TOOL_NAME: &str = "codex_script";

/// True for the code-mode wrapper `custom_tool_call`.
pub fn is_code_mode_call(tool_name: &str) -> bool {
    tool_name == CODE_MODE_TOOL_NAME
}

/// One `tools.<name>(<args>)` call recovered from a code-mode script.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodeModeCall {
    /// The inner tool's own name, exactly as codex named it before code mode
    /// (`exec_command`, `apply_patch`, `update_plan`, `mcp__srv__tool`, …).
    pub tool_name: String,
    /// `input_preview` in the pre-code-mode shape, so the frontend's existing
    /// per-tool cards match without any classification change.
    pub input_preview: String,
    /// Whether the arguments were written as a literal AT the call site, rather
    /// than resolved through an identifier's declaration. Only the inline form
    /// proves the call ran with these arguments *every* time: a variable can be
    /// reassigned between iterations (`job.cmd = cmd` inside a loop), and the
    /// declaration this scanner reads is only its first value. Attribution of a
    /// background session depends on that proof; the card preview does not.
    pub args_inline: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodeModeScript {
    /// `Some` only when EVERY call site in the script resolved. `None` means
    /// the caller must fall back to the script card.
    pub calls: Option<Vec<CodeModeCall>>,
    /// Human title for the script card (best effort, survives resolve failure).
    pub summary: Option<String>,
    /// Number of `tools.*` call sites detected, resolved or not.
    pub call_sites: usize,
    /// How many `text()` calls the script makes per result, when they provably
    /// run as one group per call in call order: `Some(n)` when the script has
    /// exactly ONE loop that walks the `Promise.all` results from the front and
    /// all n of its `text()` calls sit inside that loop's body.
    ///
    /// `None` for everything else, because everything else can reorder or
    /// regroup the chunks. `for (x of r) text(x.output)` followed by
    /// `for (x of r) text(x.exit_code)` emits exactly as many chunks as one loop
    /// printing both, but they arrive pass by pass, so slicing them into
    /// per-call groups would pin each command's output to the previous
    /// command's card. Hoisting the two `text()` calls into helpers hides that
    /// from any lexical test, which is why the loop body — not the calls'
    /// neighbourhood — is what has to contain them. `r.toReversed()` and
    /// `r[r.length - 1 - i]` walk the same results in the wrong order, so the
    /// iterable has to be the bare binding and the index has to be the loop's
    /// own counter.
    pub text_run: Option<usize>,
}

/// Terminal state reported by the code-mode output envelope's first line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScriptStatus {
    Completed,
    /// The script left a background cell running; a later `wait` collects it.
    Running,
    Failed,
    Aborted,
    /// No recognizable envelope (older codex, or a hand-rolled output).
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodeModeOutput {
    pub status: ScriptStatus,
    /// One entry per `text()` call the script made, envelope header removed.
    pub chunks: Vec<String>,
    /// Envelope line worth keeping (still-running cell id, abort reason).
    pub note: Option<String>,
}

impl CodeModeOutput {
    /// All chunks as one blob, for the paths that do not split per call.
    pub fn joined(&self) -> String {
        self.chunks.join("\n")
    }

    pub fn is_error(&self) -> bool {
        matches!(self.status, ScriptStatus::Failed | ScriptStatus::Aborted)
    }

    pub fn is_empty(&self) -> bool {
        self.chunks.iter().all(|c| c.trim().is_empty()) && self.note.is_none()
    }
}

/// Attach the envelope note (if any) to an output blob.
pub fn with_note(output: Option<String>, note: Option<&str>) -> Option<String> {
    match (output, note) {
        (Some(text), Some(note)) if text.trim().is_empty() => Some(note.to_string()),
        (Some(text), Some(note)) => Some(format!("{text}\n\n{note}")),
        (Some(text), None) => Some(text),
        (None, Some(note)) => Some(note.to_string()),
        (None, None) => None,
    }
}

/// `input_preview` payload for the fallback script card. The frontend reads
/// `source` (rendered as a JS code block), `title` and `call_count`.
pub fn script_card_input(source: &str, summary: Option<&str>, call_sites: usize) -> String {
    let mut map = Map::new();
    map.insert("source".to_string(), Value::String(source.to_string()));
    if let Some(title) = summary {
        map.insert("title".to_string(), Value::String(title.to_string()));
    }
    map.insert("call_count".to_string(), Value::from(call_sites as u64));
    Value::Object(map).to_string()
}

// ── script → calls ───────────────────────────────────────────────────────

struct ToolCallSite {
    tool_name: String,
    /// Byte index just past the opening `(`.
    args_at: usize,
}

pub fn parse_code_mode_script(src: &str) -> CodeModeScript {
    let sites = find_tool_call_sites(src);

    let mut calls = Vec::with_capacity(sites.len());
    let mut resolved = !sites.is_empty();
    for site in &sites {
        match resolve_call(src, site) {
            Some(call) => calls.push(call),
            None => {
                resolved = false;
                break;
            }
        }
    }

    let summary = best_effort_summary(src, if resolved { &calls } else { &[] }, &sites);
    CodeModeScript {
        calls: if resolved { Some(calls) } else { None },
        summary,
        call_sites: sites.len(),
        text_run: find_text_run(src),
    }
}

/// `const results = await Promise.all(` — the binding every parallel script
/// opens with, and the only handle on the results array the loop can walk.
static RESULTS_BINDING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*await\s+Promise\s*\.\s*all\s*\(")
        .expect("static regex")
});

/// See `CodeModeScript::text_run`.
///
/// This is a whitelist, and deliberately a narrow one. Earlier attempts asked
/// "does the script do anything that would break the grouping?" and kept
/// losing: two passes, then helper indirection, then `r.toReversed()`, then
/// `r.reverse()` before the loop, then a mutation hidden in a `${…}` hole, then
/// `forEach`'s third argument aliasing the array, then a deferred task per
/// iteration, then `++i` inside the body. There is no end to that list — the
/// scripts are JavaScript, and no lexical denylist covers a language.
///
/// So the question is inverted: the script has to BE the shape this proof
/// understands, and anything else keeps its script card. Measured on the newest
/// 400 rollouts, 260 of the 274 scripts that print a fixed multiple of chunks
/// per call already are exactly that shape, so the narrowness costs almost
/// nothing.
fn find_text_run(src: &str) -> Option<usize> {
    let binding = RESULTS_BINDING.captures(src)?;
    let results = binding.get(1)?.as_str();
    let declaration = binding_statement(src, binding.get(0)?.range())?;
    let walk = results_loop(src, results)?;

    // Nothing outside the declaration and the loop. Every bypass so far needed
    // somewhere to put a statement — a helper, a `r.reverse()`, a bare template
    // whose hole did the damage — and this is that somewhere.
    if !nothing_else_in_script(src, &declaration, &walk.statement) {
        return None;
    }

    // `text()` may only be called from the loop body. One inside the
    // declaration — reachable through a `${…}` hole in a command string — would
    // print a chunk before the loop and shift every group by one.
    for gap in [0..walk.body.start, walk.body.end..src.len()] {
        if code_regions(src, gap)?
            .iter()
            .any(|region| calls_text(src, region))
        {
            return None;
        }
    }

    let grammar = BodyGrammar {
        results,
        binds: &walk.binds,
        counter: walk.counter.as_deref(),
    };
    let calls = text_calls_in_body(src, &walk.body, &grammar)?;
    (calls > 0).then_some(calls)
}

/// The span of the whole `const results = await Promise.all(…);` statement,
/// given the span of the header match — which ends just past its `(`.
///
/// The argument has to be one array literal holding nothing but the calls
/// themselves. The calls are recovered by reading the source in order, so the
/// results array has to hold their results in that same order — and anything
/// applied to the array breaks that. `Promise.all([…].reverse())` does it
/// outright; `[a, ...[b, c].reverse()]` does it from the inside, which is why
/// the elements are checked and not just the brackets.
fn binding_statement(src: &str, header: Range<usize>) -> Option<Range<usize>> {
    let b = src.as_bytes();
    let elements = skip_ws_and_comments(b, header.end);
    if b.get(elements) != Some(&b'[') {
        return None;
    }
    let array_end = scan_balanced(b, elements)?;
    if !array_is_tool_calls(src, elements + 1..array_end - 1) {
        return None;
    }
    let close = skip_ws_and_comments(b, array_end);
    if b.get(close) != Some(&b')') {
        return None;
    }
    let mut end = skip_ws_and_comments(b, close + 1);
    if b.get(end) == Some(&b';') {
        end += 1;
    }
    Some(header.start..end)
}

/// Whether `elements` — the inside of the `Promise.all` array — is a plain
/// comma-separated list of `tools.…(…)` calls, one per element.
///
/// Element *i* has to be the call recovered *i*-th, and a spread is enough to
/// break that without touching the outer array.
fn array_is_tool_calls(src: &str, elements: Range<usize>) -> bool {
    let b = src.as_bytes();
    let mut i = skip_ws_and_comments(b, elements.start);
    let mut separated = true;
    while i < elements.end {
        if !separated {
            if b.get(i) != Some(&b',') {
                return false;
            }
            i = skip_ws_and_comments(b, i + 1);
            separated = true;
            continue;
        }
        if !src.get(i..).is_some_and(|rest| rest.starts_with("tools.")) {
            return false;
        }
        let mut name = i + "tools.".len();
        while name < elements.end && is_ident_byte(b[name]) {
            name += 1;
        }
        let open = skip_ws_and_comments(b, name);
        if name == i + "tools.".len() || b.get(open) != Some(&b'(') {
            return false;
        }
        let Some(close) = scan_parens(b, open) else {
            return false;
        };
        i = skip_ws_and_comments(b, close);
        separated = false;
    }
    true
}

/// The ONE loop that walks `results` from the front.
struct ResultsLoop {
    /// The whole loop statement, header and body.
    statement: Range<usize>,
    /// Inside the body — for `forEach`, inside the callback's block.
    body: Range<usize>,
    /// The counter, for the index form. The only form whose body may name the
    /// results array at all, and then only as `results[counter]`.
    counter: Option<String>,
    /// What the loop hands its body: the `for … of` variable, or the callback's
    /// parameters.
    binds: Vec<String>,
}

/// One header as matched, before the `forEach` form has been opened up into a
/// `ResultsLoop`: where the header sits, what it binds so far, the counter of
/// the index form, and whether the body is still inside a callback.
struct LoopHeader {
    header: Range<usize>,
    binds: Vec<String>,
    counter: Option<String>,
    callback: bool,
}

/// `None` when the script has no such loop, or more than one.
///
/// Three headers, and nothing else: `for (const x of results)`,
/// `results.forEach(`, and `for (let i = 0; i < results.length; i++)`. Each
/// hands its body the *i*-th result in order — the first two by binding it, the
/// third by an ascending counter. The iterable has to be the bare binding:
/// `results.toReversed()` walks the same values in the wrong order.
fn results_loop(src: &str, results: &str) -> Option<ResultsLoop> {
    let b = src.as_bytes();
    let name = regex::escape(results);
    let for_of = Regex::new(&format!(
        r"\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+of\s+{name}\s*\)"
    ))
    .ok()?;
    let for_each = Regex::new(&format!(r"\b{name}\s*\.\s*forEach\s*\(")).ok()?;
    let for_index = Regex::new(&format!(
        r"\bfor\s*\(\s*(?:let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*0\s*;\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*<\s*{name}\s*\.\s*length\s*;\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\+\+\s*\)"
    ))
    .ok()?;

    let mut found: Option<LoopHeader> = None;
    let mut hits = 0usize;
    for caps in for_of.captures_iter(src) {
        hits += 1;
        found = Some(LoopHeader {
            header: caps.get(0)?.range(),
            binds: vec![caps.get(1)?.as_str().to_string()],
            counter: None,
            callback: false,
        });
    }
    for m in for_each.find_iter(src) {
        hits += 1;
        found = Some(LoopHeader {
            header: m.range(),
            binds: Vec::new(),
            counter: None,
            callback: true,
        });
    }
    for caps in for_index.captures_iter(src) {
        hits += 1;
        let counter = caps.get(1)?.as_str();
        // The regex crate has no backreferences; the three spellings of the
        // counter have to be compared here.
        if caps.get(2)?.as_str() != counter || caps.get(3)?.as_str() != counter {
            return None;
        }
        found = Some(LoopHeader {
            header: caps.get(0)?.range(),
            binds: vec![counter.to_string()],
            counter: Some(counter.to_string()),
            callback: false,
        });
    }
    if hits != 1 {
        return None;
    }

    let LoopHeader {
        header,
        mut binds,
        counter,
        callback,
    } = found?;
    if callback {
        // `forEach` hands its callback the array itself as a third argument, so
        // a callback that takes one holds an alias this proof does not track:
        // `(x, i, all) => { if (!i) all.reverse(); … }` turns around the very
        // array the header proved was in order. Only a plain one- or
        // two-parameter arrow with a block body is accepted.
        let call_end = scan_parens(b, header.end - 1)?;
        let (params, arrow_at) = arrow_parameters(src, header.end)?;
        binds.extend(params);
        let body = block_after(src, arrow_at)?;
        // `forEach` takes a second argument, and it is evaluated before the
        // first iteration: `r.forEach(x => {…}, r.reverse())` turns the array
        // around on its way in. Nothing may follow the callback.
        if skip_ws_and_comments(b, body.end + 1) != call_end - 1 {
            return None;
        }
        let mut end = skip_ws_and_comments(b, call_end);
        if b.get(end) == Some(&b';') {
            end += 1;
        }
        return Some(ResultsLoop {
            statement: header.start..end,
            body,
            counter,
            binds,
        });
    }

    let body = block_after(src, header.end)?;
    Some(ResultsLoop {
        statement: header.start..body.end + 1,
        body,
        counter,
        binds,
    })
}

/// The parameters of the arrow function starting at `at`, and the offset just
/// past its `=>`. `None` when it is not a plain arrow of one or two simple
/// parameters — a `function` expression, a destructuring pattern, or the
/// three-parameter form that receives the array.
fn arrow_parameters(src: &str, at: usize) -> Option<(Vec<String>, usize)> {
    static ARROW: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"^\s*(?:\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:,\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*)?\)|([A-Za-z_$][A-Za-z0-9_$]*))\s*=>",
        )
        .expect("static regex")
    });
    let caps = ARROW.captures(src.get(at..)?)?;
    let params = (1..=3)
        .filter_map(|group| caps.get(group))
        .map(|m| m.as_str().to_string())
        .collect();
    Some((params, at + caps.get(0)?.end()))
}

/// Whether everything outside the two spans is whitespace, comments, or `;`.
fn nothing_else_in_script(src: &str, first: &Range<usize>, second: &Range<usize>) -> bool {
    let (first, second) = if first.start <= second.start {
        (first, second)
    } else {
        (second, first)
    };
    if first.end > second.start {
        return false;
    }
    [0..first.start, first.end..second.start, second.end..src.len()]
        .into_iter()
        .all(|gap| is_filler(src, gap))
}

fn is_filler(src: &str, gap: Range<usize>) -> bool {
    let b = src.as_bytes();
    let mut i = gap.start;
    while i < gap.end {
        let next = skip_ws_and_comments(b, i);
        if next > i {
            i = next;
            continue;
        }
        if b[i] == b';' {
            i += 1;
            continue;
        }
        return false;
    }
    true
}

/// How many `text(…)` calls the loop body is made of, or `None` if it is made
/// of anything else at all.
///
/// The body is required to be a run of `text(…)` statements whose arguments are
/// built from literals, the names the loop binds, property reads,
/// `results[counter]`, and `JSON.stringify(…)`. Nothing else parses: no
/// assignment, no `++`, no `if`, no arrow, no call to anything else, no regex
/// literal, no `await`. Those are not enumerated — they are simply not in the
/// grammar.
fn text_calls_in_body(src: &str, body: &Range<usize>, ctx: &BodyGrammar) -> Option<usize> {
    scan_body(src, body.clone(), 0, ctx)
}

/// What a loop body is allowed to name.
struct BodyGrammar<'a> {
    /// The results binding — readable only as `results[counter]`.
    results: &'a str,
    /// What the loop hands the body, plus the counter.
    binds: &'a [String],
    counter: Option<&'a str>,
}

/// Walk `range` as JavaScript tokens, returning how many `text(…)` calls it is
/// made of.
///
/// `depth` is the parenthesis nesting. At 0 — statement position — the ONLY
/// thing that parses is `text(`, `)` and `;`, which is what keeps `++i;`,
/// `if (…)`, `defer(…)`, and every assignment out without naming any of them.
/// Inside a `text(…)` argument the grammar opens up to exactly what a value can
/// be: the names the loop binds, property reads, `results[counter]`, literals,
/// `JSON.stringify(…)`, and the operators that appear in real scripts.
fn scan_body(src: &str, range: Range<usize>, start_depth: usize, ctx: &BodyGrammar) -> Option<usize> {
    let b = src.as_bytes();
    let mut calls = 0usize;
    let mut depth = start_depth;
    let mut previous: Option<&str> = None;
    let mut after_dot = false;
    // Whether the token just read can end a value, which is what tells a
    // template literal apart from a tagged one: `` tag`…` `` runs `tag` with
    // the pieces, so it is a call, not a string.
    let mut ends_value = false;
    let mut i = range.start;

    while i < range.end {
        let skipped = skip_ws_and_comments(b, i);
        if skipped > i {
            i = skipped;
            continue;
        }
        let c = b[i];

        if is_ident_start(c) {
            let mut j = i;
            while j < range.end && is_ident_byte(b[j]) {
                j += 1;
            }
            let word = &src[i..j];
            if depth == 0 {
                // `text` and then its `(`, with nothing in between. `text;` and
                // `text\n(…)` are the same program to JavaScript but not to a
                // reader, and the second is a call to whatever `(…)` builds.
                if word != "text" || after_dot || b.get(skip_ws_and_comments(b, j)) != Some(&b'(')
                {
                    return None;
                }
                calls += 1;
            } else if !after_dot
                && word != "JSON"
                && word != ctx.results
                && !ctx.binds.iter().any(|bound| bound.as_str() == word)
            {
                return None;
            }
            previous = Some(word);
            after_dot = false;
            ends_value = true;
            i = j;
            continue;
        }

        if depth > 0 && c.is_ascii_digit() {
            while i < range.end && (b[i].is_ascii_digit() || b[i] == b'.') {
                i += 1;
            }
            previous = None;
            ends_value = true;
            continue;
        }

        if depth > 0 && matches!(c, b'"' | b'\'') {
            i = scan_string(b, i);
            if i > range.end {
                return None;
            }
            previous = None;
            ends_value = true;
            continue;
        }

        if depth > 0 && c == b'`' {
            // Only a string, never a tag.
            if ends_value {
                return None;
            }
            let (end, in_holes) = scan_template_value(src, i, range.end, ctx)?;
            calls += in_holes;
            i = end;
            previous = None;
            ends_value = true;
            continue;
        }

        match c {
            // A call, and only to the two things that can neither reorder nor
            // mutate anything.
            b'(' => {
                if !matches!(previous, Some("text") | Some("stringify")) {
                    return None;
                }
                depth += 1;
                previous = None;
                ends_value = false;
            }
            b')' => {
                depth = depth.checked_sub(1)?;
                previous = None;
                ends_value = true;
            }
            b';' if depth == 0 => ends_value = false,
            // The results array is readable only at the loop's own counter.
            b'[' if depth > 0 => {
                let counter = ctx.counter?;
                if previous != Some(ctx.results) {
                    return None;
                }
                let at = skip_ws_and_comments(b, i + 1);
                let after = at + counter.len();
                if src.get(at..after) != Some(counter)
                    || b.get(after).copied().is_some_and(is_ident_byte)
                {
                    return None;
                }
                let close = skip_ws_and_comments(b, after);
                if b.get(close) != Some(&b']') {
                    return None;
                }
                i = close;
                previous = None;
                ends_value = true;
            }
            b'.' if depth > 0 => after_dot = true,
            // `++` and `--` are updates, not two operators in a row.
            b'+' if depth > 0 && b.get(i + 1) == Some(&b'+') => return None,
            b',' | b'?' | b':' | b'+' | b'|' | b'&' | b'!' if depth > 0 => {
                previous = None;
                ends_value = false;
            }
            _ => return None,
        }
        i += 1;
    }

    (depth == start_depth).then_some(calls)
}

/// Walk the template literal at `at`, applying the value grammar to each
/// `${ … }` hole. Returns the offset just past the closing backtick, and how
/// many `text(…)` calls the holes contained — always zero in practice, since
/// `text` is not a value the grammar admits.
///
/// A regex literal could hide an unbalanced brace from the hole scan —
/// `` `${/[}]/.test("}") && r.reverse()}` `` ends the hole at the character
/// class. What spills out stays hidden, but the truncated hole still begins with
/// the `/` that opened the regex, and `/` is not in the grammar, so the script
/// is rejected before any of it matters.
fn scan_template_value(
    src: &str,
    at: usize,
    limit: usize,
    ctx: &BodyGrammar,
) -> Option<(usize, usize)> {
    let b = src.as_bytes();
    let mut calls = 0usize;
    let mut i = at + 1;
    while i < limit {
        match b[i] {
            b'\\' => i += 2,
            b'`' => return Some((i + 1, calls)),
            b'$' if b.get(i + 1) == Some(&b'{') => {
                let end = scan_balanced(b, i + 1)?;
                if end > limit {
                    return None;
                }
                calls += scan_body(src, i + 2..end - 1, 1, ctx)?;
                i = end;
            }
            _ => i += 1,
        }
    }
    None
}

/// The parts of `range` that are code: everything outside string literals, plus
/// the inside of each `${ … }` hole of a template, which is code too.
///
/// `None` when a literal never closes — an unterminated string means the rest of
/// the body cannot be read with any confidence, so nothing is claimed about it.
fn code_regions(src: &str, range: Range<usize>) -> Option<Vec<Range<usize>>> {
    let b = src.as_bytes();
    let mut regions = Vec::new();
    let mut start = range.start;
    let mut i = range.start;
    while i < range.end {
        match b[i] {
            b'"' | b'\'' => {
                regions.push(start..i);
                i = scan_string(b, i);
                if i > range.end {
                    return None;
                }
                start = i;
            }
            b'`' => {
                regions.push(start..i);
                i = template_holes(src, i, range.end, &mut regions)?;
                start = i;
            }
            b'/' if matches!(b.get(i + 1), Some(b'/') | Some(b'*')) => {
                regions.push(start..i);
                i = skip_ws_and_comments(b, i);
                start = i;
            }
            _ => i += 1,
        }
    }
    regions.push(start..range.end);
    Some(regions)
}

/// Push the `${ … }` holes of the template literal at `at`, returning the offset
/// just past its closing backtick.
///
/// The hole ends at the `}` that matches its `{`, found by counting braces while
/// skipping nested literals. A regex literal could hide an unbalanced brace from
/// that count — `` `${/[}]/.test("}") && r.reverse()}` `` — but a regex literal
/// is not in the grammar the caller accepts, so a hole that ends in the wrong
/// place cannot end anywhere useful: whatever spills out of it is read as code
/// and rejected.
fn template_holes(
    src: &str,
    at: usize,
    limit: usize,
    holes: &mut Vec<Range<usize>>,
) -> Option<usize> {
    let b = src.as_bytes();
    let mut i = at + 1;
    while i < limit {
        match b[i] {
            b'\\' => i += 2,
            b'`' => return Some(i + 1),
            b'$' if b.get(i + 1) == Some(&b'{') => {
                let end = scan_balanced(b, i + 1)?;
                if end > limit {
                    return None;
                }
                holes.push(i + 2..end - 1);
                i = end;
            }
            _ => i += 1,
        }
    }
    None
}

/// Whether this stretch of code calls `text(…)`. An XPath like
/// `//div[@id="content"]//text()` inside a `cmd:` literal is not a call — 11 of
/// the candidate scripts in the sampled transcripts pass exactly that to
/// `xmllint` — which is why callers hand this code regions, never raw source.
fn calls_text(src: &str, region: &Range<usize>) -> bool {
    let b = src.as_bytes();
    let mut i = region.start;
    while i < region.end {
        let skipped = skip_ws_and_comments(b, i);
        if skipped > i {
            i = skipped;
            continue;
        }
        if is_ident_start(b[i]) {
            let mut j = i;
            while j < region.end && is_ident_byte(b[j]) {
                j += 1;
            }
            if &src[i..j] == "text"
                && !preceded_by_ident(b, i)
                && b.get(skip_ws_and_comments(b, j)) == Some(&b'(')
            {
                return true;
            }
            i = j;
            continue;
        }
        i += 1;
    }
    false
}

/// The span inside the `{ … }` that follows `at`. A single-statement body has
/// no braces to hold the several calls this is looking for, so it is not
/// accepted.
fn block_after(src: &str, at: usize) -> Option<Range<usize>> {
    let b = src.as_bytes();
    let start = skip_ws_and_comments(b, at);
    if b.get(start) != Some(&b'{') {
        return None;
    }
    let end = scan_balanced(b, start)?;
    Some(start + 1..end - 1)
}

/// `scan_balanced` for `(`/`)`, which it does not count.
fn scan_parens(b: &[u8], i: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut i = i;
    while i < b.len() {
        match b[i] {
            b'"' | b'\'' | b'`' => {
                i = scan_string(b, i);
                continue;
            }
            b'/' if matches!(b.get(i + 1), Some(b'/') | Some(b'*')) => {
                i = skip_ws_and_comments(b, i);
                continue;
            }
            b'(' => depth += 1,
            b')' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

fn find_tool_call_sites(src: &str) -> Vec<ToolCallSite> {
    let b = src.as_bytes();
    let mut sites = Vec::new();
    let mut i = 0usize;

    while i < b.len() {
        match b[i] {
            b'"' | b'\'' | b'`' => {
                i = scan_string(b, i);
                continue;
            }
            b'/' if matches!(b.get(i + 1), Some(b'/') | Some(b'*')) => {
                i = skip_ws_and_comments(b, i);
                continue;
            }
            b't' if src[i..].starts_with("tools.") && !preceded_by_ident(b, i) => {
                let name_start = i + "tools.".len();
                let mut j = name_start;
                while j < b.len() && is_ident_byte(b[j]) {
                    j += 1;
                }
                if j > name_start {
                    let k = skip_ws_and_comments(b, j);
                    if b.get(k) == Some(&b'(') {
                        sites.push(ToolCallSite {
                            tool_name: src[name_start..j].to_string(),
                            args_at: k + 1,
                        });
                        i = k + 1;
                        continue;
                    }
                }
                i = j.max(i + 1);
                continue;
            }
            _ => i += 1,
        }
    }

    sites
}

fn resolve_call(src: &str, site: &ToolCallSite) -> Option<CodeModeCall> {
    let (args, args_inline) = resolve_call_args(src, site.args_at)?;
    let input_preview = call_input_preview(&site.tool_name, &args)?;
    Some(CodeModeCall {
        tool_name: site.tool_name.clone(),
        input_preview,
        args_inline,
    })
}

/// The call's arguments, and whether they were literal at the call site.
fn resolve_call_args(src: &str, args_at: usize) -> Option<(Value, bool)> {
    let b = src.as_bytes();
    let start = skip_ws_and_comments(b, args_at);
    // Whatever the argument starts with, it has to BE the whole argument. The
    // literal in `tools.exec_command({cmd: "pnpm build"} && job)` is not what
    // runs, and reading it as one would credit `job`'s command — and any
    // background session it announces — to text that never executed. All 19183
    // inline call sites in the sampled transcripts close right after the
    // literal, so the check costs no recovery.
    let ends_argument = |at: usize| b.get(skip_ws_and_comments(b, at)) == Some(&b')');
    match b.get(start)? {
        b'{' | b'[' => {
            let end = scan_balanced(b, start)?;
            if !ends_argument(end) {
                return None;
            }
            js_literal_to_json(src.get(start..end)?).map(|args| (args, true))
        }
        c if is_ident_start(*c) => {
            let mut j = start;
            while j < b.len() && is_ident_byte(b[j]) {
                j += 1;
            }
            let ident = src.get(start..j)?;
            // Only a bare `tools.foo(ident)` is resolvable; anything else
            // (member access, call, arithmetic) needs a real interpreter.
            if !ends_argument(j) {
                return None;
            }
            resolve_declaration(src, ident).map(|args| (args, false))
        }
        _ => None,
    }
}

/// Rebuild the `input_preview` codex wrote before code mode, so the existing
/// per-tool renderers match verbatim. Verified against May/June rollouts:
/// `exec_command` carried the bare command, `apply_patch` the bare patch text,
/// everything else the JSON argument object.
fn call_input_preview(tool_name: &str, args: &Value) -> Option<String> {
    match tool_name {
        "exec_command" => {
            let cmd = args
                .get("cmd")
                .or_else(|| args.get("command"))
                .and_then(|v| v.as_str())?;
            Some(cmd.to_string())
        }
        "apply_patch" => {
            if let Some(text) = args.as_str() {
                return Some(text.to_string());
            }
            let patch = args
                .get("patch")
                .or_else(|| args.get("input"))
                .and_then(|v| v.as_str())?;
            Some(patch.to_string())
        }
        _ => match args {
            Value::String(s) => Some(s.clone()),
            Value::Object(_) | Value::Array(_) => Some(args.to_string()),
            _ => None,
        },
    }
}

/// Resolve `const|let|var <ident> = <literal>` declared anywhere in the script.
/// Covers the `const patch = "*** Begin Patch…"; tools.apply_patch(patch)` shape.
fn resolve_declaration(src: &str, ident: &str) -> Option<Value> {
    let b = src.as_bytes();
    let mut i = 0usize;

    while i < b.len() {
        match b[i] {
            b'"' | b'\'' | b'`' => {
                i = scan_string(b, i);
                continue;
            }
            b'/' if matches!(b.get(i + 1), Some(b'/') | Some(b'*')) => {
                i = skip_ws_and_comments(b, i);
                continue;
            }
            _ => {}
        }
        if let Some(value) = try_declaration_at(src, i, ident) {
            return Some(value);
        }
        i += 1;
    }

    None
}

fn try_declaration_at(src: &str, i: usize, ident: &str) -> Option<Value> {
    let b = src.as_bytes();
    if preceded_by_ident(b, i) {
        return None;
    }
    let rest = src.get(i..)?;
    let keyword = ["const", "let", "var"]
        .into_iter()
        .find(|kw| rest.starts_with(kw))?;

    let mut j = i + keyword.len();
    if !b.get(j).is_some_and(|c| c.is_ascii_whitespace()) {
        return None;
    }
    j = skip_ws_and_comments(b, j);
    if !src.get(j..)?.starts_with(ident) {
        return None;
    }
    j += ident.len();
    if b.get(j).is_some_and(|c| is_ident_byte(*c)) {
        return None;
    }
    j = skip_ws_and_comments(b, j);
    if b.get(j) != Some(&b'=') || b.get(j + 1) == Some(&b'=') {
        return None;
    }

    let value_at = skip_ws_and_comments(b, j + 1);
    match b.get(value_at)? {
        b'"' | b'\'' | b'`' => {
            let end = scan_string(b, value_at);
            js_literal_to_json(src.get(value_at..end)?)
        }
        b'{' | b'[' => {
            let end = scan_balanced(b, value_at)?;
            js_literal_to_json(src.get(value_at..end)?)
        }
        _ => None,
    }
}

/// Title for the script card. Prefers a resolved command, then any literal
/// `cmd:` in the source (so the destructuring shapes still get a real title),
/// then the first tool name.
fn best_effort_summary(
    src: &str,
    calls: &[CodeModeCall],
    sites: &[ToolCallSite],
) -> Option<String> {
    if let Some(call) = calls.iter().find(|c| c.tool_name == "exec_command") {
        return first_line(&call.input_preview);
    }
    if let Some(cmd) = first_command_literal(src) {
        return first_line(&cmd);
    }
    if let Some(call) = calls.first() {
        return Some(call.tool_name.clone());
    }
    sites.first().map(|s| s.tool_name.clone())
}

fn first_line(text: &str) -> Option<String> {
    let line = text.lines().find(|l| !l.trim().is_empty())?.trim();
    if line.is_empty() {
        None
    } else {
        Some(line.to_string())
    }
}

/// First `cmd: "…"` / `command: "…"` string literal in the script.
fn first_command_literal(src: &str) -> Option<String> {
    let b = src.as_bytes();
    let mut i = 0usize;

    while i < b.len() {
        match b[i] {
            b'"' | b'\'' | b'`' => {
                // A quoted key is still a key: peek before skipping the string.
                let end = scan_string(b, i);
                if let Some(key) = src
                    .get(i..end)
                    .and_then(|raw| decode_js_string(raw, b[i]))
                    .filter(|key| key == "cmd" || key == "command")
                {
                    let _ = key;
                    if let Some(value) = command_value_after(src, end) {
                        return Some(value);
                    }
                }
                i = end;
                continue;
            }
            b'/' if matches!(b.get(i + 1), Some(b'/') | Some(b'*')) => {
                i = skip_ws_and_comments(b, i);
                continue;
            }
            b'c' if !preceded_by_ident(b, i) => {
                let mut j = i;
                while j < b.len() && is_ident_byte(b[j]) {
                    j += 1;
                }
                let word = src.get(i..j).unwrap_or("");
                if word == "cmd" || word == "command" {
                    if let Some(value) = command_value_after(src, j) {
                        return Some(value);
                    }
                }
                i = j.max(i + 1);
                continue;
            }
            _ => i += 1,
        }
    }

    None
}

fn command_value_after(src: &str, key_end: usize) -> Option<String> {
    let b = src.as_bytes();
    let colon = skip_ws_and_comments(b, key_end);
    if b.get(colon) != Some(&b':') {
        return None;
    }
    let value_at = skip_ws_and_comments(b, colon + 1);
    match b.get(value_at)? {
        q @ (b'"' | b'\'' | b'`') => {
            let end = scan_string(b, value_at);
            decode_js_string(src.get(value_at..end)?, *q)
        }
        _ => None,
    }
}

// ── output envelope ──────────────────────────────────────────────────────

const HEADER_COMPLETED: &str = "Script completed";
const HEADER_FAILED: &str = "Script failed";
const HEADER_RUNNING: &str = "Script running with cell ID";
const HEADER_ABORTED: &str = "aborted by user";

/// Split a code-mode `output` into per-`text()` chunks with the
/// `Script …/Wall time …/Output:` envelope removed.
///
/// Codex writes the output as an ARRAY of `{type:"input_text", text}` parts —
/// serializing that array as JSON is what leaked raw `[{"text":"Script
/// completed…` into the result panel.
pub fn split_code_mode_output(output: Option<&Value>) -> CodeModeOutput {
    let mut chunks = collect_output_chunks(output);
    let mut status = ScriptStatus::Unknown;
    let mut note = None;

    if let Some(first) = chunks.first_mut() {
        if let Some(header) = strip_script_header(first) {
            status = header.status;
            note = header.note;
            *first = header.rest;
        }
    }
    if chunks.first().is_some_and(|c| c.is_empty()) {
        chunks.remove(0);
    }

    CodeModeOutput {
        status,
        chunks,
        note,
    }
}

fn collect_output_chunks(output: Option<&Value>) -> Vec<String> {
    match output {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Array(items)) => items.iter().filter_map(chunk_text).collect(),
        Some(other) => chunk_text(other).into_iter().collect(),
    }
}

fn chunk_text(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Object(map) => match map.get("text").and_then(|t| t.as_str()) {
            Some(text) => Some(text.to_string()),
            None => Some(value.to_string()),
        },
        other => Some(other.to_string()),
    }
}

struct StrippedHeader {
    status: ScriptStatus,
    note: Option<String>,
    rest: String,
}

fn strip_script_header(text: &str) -> Option<StrippedHeader> {
    let (first, after) = split_first_line(text);
    let trimmed = first.trim_end();

    let (status, note) = if trimmed == HEADER_COMPLETED {
        (ScriptStatus::Completed, None)
    } else if trimmed == HEADER_FAILED {
        (ScriptStatus::Failed, None)
    } else if trimmed.starts_with(HEADER_RUNNING) {
        (ScriptStatus::Running, Some(trimmed.to_string()))
    } else if trimmed.to_ascii_lowercase().starts_with(HEADER_ABORTED) {
        (ScriptStatus::Aborted, Some(trimmed.to_string()))
    } else {
        return None;
    };

    let rest = drop_line_if(after, |line| {
        line.to_ascii_lowercase().starts_with("wall time")
    });
    let rest = drop_line_if(rest, |line| line.eq_ignore_ascii_case("output:"));

    Some(StrippedHeader {
        status,
        note,
        rest: rest.to_string(),
    })
}

fn split_first_line(text: &str) -> (&str, &str) {
    match text.find('\n') {
        Some(idx) => (&text[..idx], &text[idx + 1..]),
        None => (text, ""),
    }
}

fn drop_line_if(text: &str, pred: impl Fn(&str) -> bool) -> &str {
    let (line, after) = split_first_line(text);
    if pred(line.trim()) {
        after
    } else {
        text
    }
}

// ── background shell sessions ────────────────────────────────────────────

/// Phrases codex uses to announce a background shell session's id. Matched
/// case-insensitively, anchored on the `with ` AND on the trailing space, so a
/// command whose *output* merely mentions a session id cannot mint a bogus
/// mapping. Both anchors earn their keep against real transcripts: the
/// commentary line `…established with agent-assigned session ID` fails the
/// first, and a markdown heading `### Streamable HTTP with Session ID` (whose
/// next line starts with a line number) fails the second.
const SESSION_ID_PHRASES: [&str; 2] = ["with session id ", "with cell id "];

/// The same id inside the JSON result a code-mode `tools.exec_command(…)`
/// returns. Value may be a number or a quoted string.
const SESSION_ID_JSON_KEY: &str = "\"session_id\"";

/// codex stamps every exec result with a chunk id, in the prose envelope
/// (`Chunk ID: 98f2d1`) as well as the code-mode JSON one
/// (`{"chunk_id":"a74f94","wall_time_seconds":…,"session_id":7106,…}`).
///
/// The `"session_id"` JSON form is only honored inside such an envelope:
/// printing that key is an extremely ordinary thing for a command to do
/// (`grep -rn session_id src/` hits it thousands of times in this very repo),
/// and a bogus mapping would put the wrong command in a `wait` card's title.
/// The two prose phrases need no such gate — they are codex's own wording.
const CHUNK_ID_MARKERS: [&str; 2] = ["chunk id:", "\"chunk_id\""];

/// Background shell session ids announced by one tool output — the ids a later
/// `wait` (`cell_id`) or `write_stdin` (`session_id`) call addresses.
///
/// codex publishes them in three shapes, all present in real rollouts:
///
/// ```text
/// Chunk ID: 523e44 … Process running with session ID 22068   (string envelope)
/// Script running with cell ID 56                             (code-mode header)
/// {"chunk_id":"a74f94","session_id":7106,"output":""}        (code-mode result)
/// ```
///
/// Returned in announcement order with duplicates collapsed.
pub fn extract_shell_session_ids(text: &str) -> Vec<String> {
    let lower = text.to_ascii_lowercase();
    let mut hits: Vec<(usize, String)> = Vec::new();

    for phrase in SESSION_ID_PHRASES {
        let mut from = 0;
        while let Some(offset) = lower[from..].find(phrase) {
            let at = from + offset + phrase.len();
            if let Some(id) = leading_digits(&lower[at..]) {
                hits.push((at, id));
            }
            from = at;
        }
    }

    if CHUNK_ID_MARKERS.iter().any(|m| lower.contains(m)) {
        let mut from = 0;
        while let Some(offset) = lower[from..].find(SESSION_ID_JSON_KEY) {
            let at = from + offset + SESSION_ID_JSON_KEY.len();
            let value = lower[at..].trim_start_matches([' ', ':', '"']);
            if let Some(id) = leading_digits(value) {
                hits.push((at, id));
            }
            from = at;
        }
    }

    hits.sort_by_key(|(at, _)| *at);
    let mut ids: Vec<String> = Vec::with_capacity(hits.len());
    for (_, id) in hits {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids
}

/// The chunk ids stamped on one tool output. codex lets a `wait` address a cell
/// by the hex chunk id of the envelope that announced it just as well as by the
/// numeric session id inside — `{"cell_id":"8716ba"}` and `{"cell_id":"13185"}`
/// name the same cell when the envelope reads
/// `{"chunk_id":"8716ba",…,"session_id":13185,…}`.
///
/// Only meaningful next to a session announcement, which is the caller's to
/// check: every exec result carries a chunk id, and one from a command that has
/// already exited names nothing to poll.
pub fn extract_chunk_ids(text: &str) -> Vec<String> {
    let lower = text.to_ascii_lowercase();
    let mut ids: Vec<String> = Vec::new();
    for marker in CHUNK_ID_MARKERS {
        let mut from = 0;
        while let Some(offset) = lower[from..].find(marker) {
            let at = from + offset + marker.len();
            let value = lower[at..].trim_start_matches([' ', ':', '"']);
            let id: String = value
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric())
                .collect();
            if !id.is_empty() && !ids.contains(&id) {
                ids.push(id);
            }
            from = at;
        }
    }
    ids
}

fn leading_digits(text: &str) -> Option<String> {
    let digits: String = text.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        None
    } else {
        Some(digits)
    }
}

// ── JS literal scanning ──────────────────────────────────────────────────

fn is_ident_byte(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || c == b'$'
}

fn is_ident_start(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'_' || c == b'$'
}

fn preceded_by_ident(b: &[u8], i: usize) -> bool {
    i > 0 && (is_ident_byte(b[i - 1]) || b[i - 1] == b'.')
}

fn skip_ws_and_comments(b: &[u8], mut i: usize) -> usize {
    loop {
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if b.get(i) == Some(&b'/') && b.get(i + 1) == Some(&b'/') {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if b.get(i) == Some(&b'/') && b.get(i + 1) == Some(&b'*') {
            i += 2;
            while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(b.len());
            continue;
        }
        return i;
    }
}

/// `i` points at the opening quote. Returns the index just past the closing
/// quote (or `b.len()` when unterminated). Template `${…}` holes are skipped
/// as balanced blocks so a `}` inside them cannot end an enclosing literal.
fn scan_string(b: &[u8], i: usize) -> usize {
    let quote = b[i];
    let mut i = i + 1;
    while i < b.len() {
        let c = b[i];
        if c == b'\\' {
            i += 2;
            continue;
        }
        if c == quote {
            return i + 1;
        }
        if quote == b'`' && c == b'$' && b.get(i + 1) == Some(&b'{') {
            i = scan_balanced(b, i + 1).unwrap_or(b.len());
            continue;
        }
        i += 1;
    }
    b.len()
}

/// `i` points at `{` or `[`. Returns the index just past the matching close.
fn scan_balanced(b: &[u8], i: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut i = i;
    while i < b.len() {
        match b[i] {
            b'"' | b'\'' | b'`' => {
                i = scan_string(b, i);
                continue;
            }
            b'/' if matches!(b.get(i + 1), Some(b'/') | Some(b'*')) => {
                i = skip_ws_and_comments(b, i);
                continue;
            }
            b'{' | b'[' => depth += 1,
            b'}' | b']' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Parse a JS literal (object / array / string / number / keyword) into JSON.
/// Returns `None` for anything that needs evaluation: identifiers, shorthand
/// properties, spreads, template interpolation, calls.
pub fn js_literal_to_json(src: &str) -> Option<Value> {
    let mut parser = LiteralParser::new(src);
    let value = parser.value()?;
    parser.skip();
    if parser.i != parser.b.len() {
        return None;
    }
    Some(value)
}

struct LiteralParser<'a> {
    src: &'a str,
    b: &'a [u8],
    i: usize,
}

impl<'a> LiteralParser<'a> {
    fn new(src: &'a str) -> Self {
        Self {
            src,
            b: src.as_bytes(),
            i: 0,
        }
    }

    fn skip(&mut self) {
        self.i = skip_ws_and_comments(self.b, self.i);
    }

    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }

    fn value(&mut self) -> Option<Value> {
        self.skip();
        match self.peek()? {
            b'{' => self.object(),
            b'[' => self.array(),
            q @ (b'"' | b'\'' | b'`') => self.string(q).map(Value::String),
            c if is_ident_start(c) => self.keyword(),
            _ => self.number(),
        }
    }

    fn object(&mut self) -> Option<Value> {
        self.i += 1; // consume '{'
        let mut map = Map::new();
        loop {
            self.skip();
            match self.peek()? {
                b'}' => {
                    self.i += 1;
                    return Some(Value::Object(map));
                }
                b',' => {
                    self.i += 1;
                    continue;
                }
                // spread (`...rest`) needs evaluation
                b'.' => return None,
                _ => {}
            }
            let key = self.key()?;
            self.skip();
            // A missing `:` means shorthand (`{cmd, workdir}`) or a method —
            // both carry values only the runtime knows.
            if self.peek()? != b':' {
                return None;
            }
            self.i += 1;
            let value = self.value()?;
            map.insert(key, value);
        }
    }

    fn array(&mut self) -> Option<Value> {
        self.i += 1; // consume '['
        let mut items = Vec::new();
        loop {
            self.skip();
            match self.peek()? {
                b']' => {
                    self.i += 1;
                    return Some(Value::Array(items));
                }
                b',' => {
                    self.i += 1;
                    continue;
                }
                b'.' => return None,
                _ => {}
            }
            items.push(self.value()?);
        }
    }

    fn key(&mut self) -> Option<String> {
        self.skip();
        match self.peek()? {
            q @ (b'"' | b'\'' | b'`') => self.string(q),
            c if is_ident_start(c) || c.is_ascii_digit() => {
                let start = self.i;
                while self.i < self.b.len() && is_ident_byte(self.b[self.i]) {
                    self.i += 1;
                }
                Some(self.src.get(start..self.i)?.to_string())
            }
            // A computed key (`[expr]: …`) is not statically known.
            _ => None,
        }
    }

    fn string(&mut self, quote: u8) -> Option<String> {
        let end = scan_string(self.b, self.i);
        let raw = self.src.get(self.i..end)?;
        self.i = end;
        decode_js_string(raw, quote)
    }

    fn keyword(&mut self) -> Option<Value> {
        let start = self.i;
        while self.i < self.b.len() && is_ident_byte(self.b[self.i]) {
            self.i += 1;
        }
        match self.src.get(start..self.i)? {
            "true" => Some(Value::Bool(true)),
            "false" => Some(Value::Bool(false)),
            "null" | "undefined" => Some(Value::Null),
            // Any other bare identifier is a variable reference.
            _ => None,
        }
    }

    fn number(&mut self) -> Option<Value> {
        let start = self.i;
        if self.peek() == Some(b'-') {
            self.i += 1;
        }
        let digits_start = self.i;
        while self
            .peek()
            .is_some_and(|c| c.is_ascii_digit() || c == b'.')
        {
            self.i += 1;
        }
        if self.i == digits_start {
            return None;
        }
        if matches!(self.peek(), Some(b'e') | Some(b'E')) {
            self.i += 1;
            if matches!(self.peek(), Some(b'+') | Some(b'-')) {
                self.i += 1;
            }
            while self.peek().is_some_and(|c| c.is_ascii_digit()) {
                self.i += 1;
            }
        }
        // `10n`, `0x1f`, `1_000` — not plain JSON numbers.
        if self.peek().is_some_and(is_ident_byte) {
            return None;
        }
        serde_json::from_str::<Value>(self.src.get(start..self.i)?).ok()
    }
}

/// Decode a JS string literal (quotes included) into its runtime value.
/// Template literals carrying a `${…}` hole are rejected — their value is only
/// known at runtime.
fn decode_js_string(raw: &str, quote: u8) -> Option<String> {
    let quote = quote as char;
    let inner = raw.strip_prefix(quote)?.strip_suffix(quote)?;
    let chars: Vec<char> = inner.chars().collect();
    let mut out = String::with_capacity(inner.len());
    let mut i = 0usize;

    while i < chars.len() {
        let c = chars[i];
        if c != '\\' {
            if quote == '`' && c == '$' && chars.get(i + 1) == Some(&'{') {
                return None;
            }
            out.push(c);
            i += 1;
            continue;
        }
        i += 1;
        let escape = *chars.get(i)?;
        i += 1;
        match escape {
            'n' => out.push('\n'),
            't' => out.push('\t'),
            'r' => out.push('\r'),
            'b' => out.push('\u{8}'),
            'f' => out.push('\u{c}'),
            'v' => out.push('\u{b}'),
            '0' if !chars.get(i).is_some_and(|c| c.is_ascii_digit()) => out.push('\0'),
            '\n' => {}
            'x' => {
                let value = hex_value(&chars, i, 2)?;
                i += 2;
                out.push(char::from_u32(value).unwrap_or('\u{fffd}'));
            }
            'u' => {
                if chars.get(i) == Some(&'{') {
                    let close = chars[i..].iter().position(|c| *c == '}')? + i;
                    let text: String = chars[i + 1..close].iter().collect();
                    let value = u32::from_str_radix(&text, 16).ok()?;
                    i = close + 1;
                    out.push(char::from_u32(value).unwrap_or('\u{fffd}'));
                } else {
                    let value = hex_value(&chars, i, 4)?;
                    i += 4;
                    // Recombine a surrogate pair written as two \uXXXX escapes.
                    if (0xd800..0xdc00).contains(&value)
                        && chars.get(i) == Some(&'\\')
                        && chars.get(i + 1) == Some(&'u')
                    {
                        if let Some(low) = hex_value(&chars, i + 2, 4) {
                            if (0xdc00..0xe000).contains(&low) {
                                i += 6;
                                let combined =
                                    0x10000 + ((value - 0xd800) << 10) + (low - 0xdc00);
                                out.push(char::from_u32(combined).unwrap_or('\u{fffd}'));
                                continue;
                            }
                        }
                    }
                    out.push(char::from_u32(value).unwrap_or('\u{fffd}'));
                }
            }
            other => out.push(other),
        }
    }

    Some(out)
}

fn hex_value(chars: &[char], at: usize, len: usize) -> Option<u32> {
    let slice = chars.get(at..at + len)?;
    let text: String = slice.iter().collect();
    u32::from_str_radix(&text, 16).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn calls(src: &str) -> Vec<CodeModeCall> {
        parse_code_mode_script(src)
            .calls
            .unwrap_or_else(|| panic!("script did not resolve: {src}"))
    }

    #[test]
    fn single_exec_command_resolves_to_bare_command() {
        let src = "const r = await tools.exec_command({\n  cmd: \"git status --short\",\n  workdir: \"/repo\",\n  yield_time_ms: 10000\n});\ntext(r.output);\n";
        let got = calls(src);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].tool_name, "exec_command");
        assert_eq!(got[0].input_preview, "git status --short");
    }

    #[test]
    fn quoted_keys_and_escapes_decode() {
        let src = r#"const r=await tools.exec_command({"cmd":"sed -n '1,20p' \"a b.txt\"\nwc -l","workdir":"/repo"}); text(r.output)"#;
        let got = calls(src);
        assert_eq!(got[0].input_preview, "sed -n '1,20p' \"a b.txt\"\nwc -l");
    }

    #[test]
    fn braces_inside_strings_do_not_end_the_literal() {
        let src = r#"const r = await tools.exec_command({cmd: "awk '{print $1}' f | sed 's/}/]/'", workdir: "/repo"}); text(r.output)"#;
        let got = calls(src);
        assert_eq!(got[0].input_preview, "awk '{print $1}' f | sed 's/}/]/'");
    }

    #[test]
    fn comments_and_trailing_commas_are_tolerated() {
        let src = "const r = await tools.exec_command({\n  // read it\n  cmd: 'ls -la', /* inline */\n  workdir: '/repo',\n});";
        let got = calls(src);
        assert_eq!(got[0].input_preview, "ls -la");
    }

    #[test]
    fn parallel_calls_keep_source_order() {
        let src = "const rs = await Promise.all([\n  tools.exec_command({cmd:\"one\"}),\n  tools.exec_command({cmd:\"two\"}),\n  tools.exec_command({cmd:\"three\"})\n]);\nrs.forEach(r => text(r.output));";
        let got = calls(src);
        assert_eq!(
            got.iter().map(|c| c.input_preview.as_str()).collect::<Vec<_>>(),
            vec!["one", "two", "three"]
        );
    }

    #[test]
    fn apply_patch_resolves_through_a_declaration() {
        let src = "const patch = \"*** Begin Patch\\n*** Update File: a.rs\\n+x\\n*** End Patch\";\nconst result = await tools.apply_patch(patch);\ntext(result);\n";
        let got = calls(src);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].tool_name, "apply_patch");
        assert_eq!(
            got[0].input_preview,
            "*** Begin Patch\n*** Update File: a.rs\n+x\n*** End Patch"
        );
    }

    #[test]
    fn mcp_and_plan_calls_keep_their_json_arguments() {
        let src = "const plan = await tools.update_plan({plan:[{step:\"a\",status:\"pending\"}]});\nconst r = await tools.mcp__codeg_mcp__get_delegation_status({task_ids:[\"t1\"],wait_ms:60000});\ntext(JSON.stringify(r));";
        let got = calls(src);
        assert_eq!(got[0].tool_name, "update_plan");
        assert_eq!(
            got[0].input_preview,
            r#"{"plan":[{"status":"pending","step":"a"}]}"#
        );
        assert_eq!(got[1].tool_name, "mcp__codeg_mcp__get_delegation_status");
        assert_eq!(
            got[1].input_preview,
            r#"{"task_ids":["t1"],"wait_ms":60000}"#
        );
    }

    const TWO_CALLS: &str = "const r = await Promise.all([tools.exec_command({cmd:\"a\"}), tools.exec_command({cmd:\"b\"})]);\n";

    #[test]
    fn one_loop_printing_twice_groups_two_chunks_per_call() {
        let src = format!(
            "{TWO_CALLS}for (const x of r) {{ text(x.output); text(`exit_code=${{x.exit_code}}`); }}\n"
        );
        assert_eq!(parse_code_mode_script(&src).text_run, Some(2));
    }

    #[test]
    fn a_foreach_body_counts_the_same_way() {
        let src = format!("{TWO_CALLS}r.forEach((x, i) => {{ text(`---RESULT ${{i}}---`); text(x.output); }});\n");
        assert_eq!(parse_code_mode_script(&src).text_run, Some(2));
    }

    #[test]
    fn an_index_loop_over_the_results_counts_the_same_way() {
        let src = format!("{TWO_CALLS}for (let i = 0; i < r.length; i++) {{ text(`---RESULT ${{i}}---`); text(r[i].output); }}\n");
        assert_eq!(parse_code_mode_script(&src).text_run, Some(2));
    }

    /// Same two `text()` calls, same chunk count — but two passes, so the chunks
    /// arrive output-output-exit-exit and cannot be grouped per call.
    #[test]
    fn two_passes_over_the_results_do_not_group() {
        let src = format!(
            "{TWO_CALLS}for (const x of r) text(x.output);\nfor (const x of r) text(`exit_code=${{x.exit_code}}`);\n"
        );
        assert_eq!(parse_code_mode_script(&src).text_run, None);
    }

    /// The same two passes with the calls hoisted into helpers: the `text()`
    /// calls now sit side by side at the top of the script, so only the loop
    /// body — not their neighbourhood — tells the shapes apart.
    #[test]
    fn text_calls_hoisted_out_of_the_loop_do_not_group() {
        let src = format!(
            "{TWO_CALLS}const emitOutput = x => text(x.output);\nconst emitExit = x => text(`exit_code=${{x.exit_code}}`);\nfor (const x of r) emitOutput(x);\nfor (const x of r) emitExit(x);\n"
        );
        assert_eq!(parse_code_mode_script(&src).text_run, None);
    }

    /// The loop header names the binding, but the array it walks was turned
    /// around in place before it got there — so group *i* is call *n - 1 - i*
    /// even though every other check passes.
    #[test]
    fn a_results_array_reordered_before_the_loop_does_not_group() {
        for mutation in ["r.reverse();", "r.sort();", "r.splice(0, 1);", "r = other;"] {
            let src = format!(
                "{TWO_CALLS}{mutation}\nfor (const x of r) {{ text(x.output); text(`exit_code=${{x.exit_code}}`); }}\n"
            );
            assert_eq!(
                parse_code_mode_script(&src).text_run,
                None,
                "{mutation} must not be treated as a plain walk"
            );
        }
    }

    /// `++` is an update, not two `+` in a row — and it can move the counter
    /// out from under the very read that names the call.
    #[test]
    fn a_prefix_update_inside_an_argument_does_not_group() {
        let src = format!(
            "{TWO_CALLS}for (let i = 0; i < r.length; i++) {{ text(\"slot\"); text(i ? ++i : r[i].output); }}\n"
        );
        assert_eq!(parse_code_mode_script(&src).text_run, None);
    }

    /// `forEach` takes a second argument, and it runs before the first
    /// iteration.
    #[test]
    fn a_foreach_second_argument_does_not_group() {
        let src = format!(
            "{TWO_CALLS}r.forEach(x => {{ text(\"slot\"); text(x.output); }}, r.reverse());\n"
        );
        assert_eq!(parse_code_mode_script(&src).text_run, None);
    }

    /// The calls are recovered in source order, so the array `Promise.all`
    /// receives has to be the one written at the call sites — reordered from
    /// outside, or from within by a spread.
    #[test]
    fn a_reordered_promise_all_argument_does_not_group() {
        let walk = "\nfor (const x of r) { text(\"slot\"); text(x.output); }\n";
        for arg in [
            "[tools.exec_command({cmd:\"a\"}), tools.exec_command({cmd:\"b\"})].reverse()",
            "[tools.exec_command({cmd:\"a\"}), ...[tools.exec_command({cmd:\"b\"}), tools.exec_command({cmd:\"c\"})].reverse()]",
            "[tools.exec_command({cmd:\"a\"})].concat([tools.exec_command({cmd:\"b\"})])",
        ] {
            let src = format!("const r = await Promise.all({arg});{walk}");
            assert_eq!(parse_code_mode_script(&src).text_run, None, "{arg}");
        }
    }

    /// `` tag`…` `` calls `tag`. Reading it as a string would let the body run
    /// code the grammar never sees.
    #[test]
    fn a_tagged_template_is_not_a_string() {
        let src = format!(
            "{TWO_CALLS}for (const x of r) {{ text(\"slot\"); text(JSON.stringify.constructor`return 1`); }}\n"
        );
        assert_eq!(parse_code_mode_script(&src).text_run, None);

        // The same trick at statement position, where `text` is the only
        // identifier that parses and it must be followed by its `(`.
        let split = format!("{TWO_CALLS}for (const x of r) {{ text;\n(JSON.stringify.constructor`return 1`); text(x.output); }}\n");
        assert_eq!(parse_code_mode_script(&split).text_run, None);
    }

    /// A literal that never closes means the rest cannot be read with any
    /// confidence — say nothing, and do not panic saying it.
    #[test]
    fn malformed_literals_are_refused_without_panicking() {
        for tail in [
            "for (const x of r) { text(\"unterminated); text(x.output); }",
            "for (const x of r) { text(`unterminated ${x.output}); }",
            "for (const x of r) { text(x.output); /* unterminated",
            "for (const x of r) { text(`${`nested",
        ] {
            let src = format!("{TWO_CALLS}{tail}");
            assert_eq!(parse_code_mode_script(&src).text_run, None, "{tail}");
        }
    }

    /// `${…}` is code, not text. A mutation hidden in one is still a mutation.
    #[test]
    fn a_mutation_inside_a_template_hole_does_not_group() {
        let src = format!(
            "{TWO_CALLS}`${{r.reverse()}}`;\nfor (const x of r) {{ text(x.output); text(\"done\"); }}\n"
        );
        assert_eq!(parse_code_mode_script(&src).text_run, None);
    }

    /// `forEach` hands its callback the array itself as a third argument, which
    /// is an alias no lexical check on `r` can see.
    #[test]
    fn a_foreach_callback_taking_the_array_does_not_group() {
        let src = format!(
            "{TWO_CALLS}r.forEach((x, i, all) => {{ if (!i) all.reverse(); text(all[i].output); text(\"done\"); }});\n"
        );
        assert_eq!(parse_code_mode_script(&src).text_run, None);
    }

    /// Every `text()` is inside the one loop body, but they run from a callback
    /// scheduled per iteration, so what they print need not arrive in the order
    /// the loop ran.
    #[test]
    fn deferred_work_inside_the_loop_does_not_group() {
        let src = format!(
            "{TWO_CALLS}for (const x of r) {{ setTimeout(() => {{ text(x.output); text(\"done\"); }}, 0); }}\n"
        );
        assert_eq!(parse_code_mode_script(&src).text_run, None);
    }

    /// The counter is what makes the index form ordered. Writing to it — or to
    /// the slot it reads — takes that away.
    #[test]
    fn writing_to_the_counter_or_its_slot_does_not_group() {
        for body in [
            "const j = i; i = 1 - i; text(r[i].output); i = j;",
            "r[i] = r[0]; text(r[i].output); text(\"done\");",
        ] {
            let src = format!("{TWO_CALLS}for (let i = 0; i < r.length; i++) {{ {body} }}\n");
            assert_eq!(
                parse_code_mode_script(&src).text_run,
                None,
                "must not group: {body}"
            );
        }
    }

    /// One loop, contiguous groups — but walking the results backwards, so
    /// group *i* is call *n - 1 - i*.
    #[test]
    fn a_reversed_walk_does_not_group() {
        let reversed = format!(
            "{TWO_CALLS}for (const x of r.toReversed()) {{ text(x.output); text(`exit_code=${{x.exit_code}}`); }}\n"
        );
        assert_eq!(parse_code_mode_script(&reversed).text_run, None);

        let by_index = format!("{TWO_CALLS}for (let i = 0; i < r.length; i++) {{ text(`---${{i}}---`); text(r[r.length - 1 - i].output); }}\n");
        assert_eq!(parse_code_mode_script(&by_index).text_run, None);
    }

    /// `//text()` is an XPath inside a command string, not a call site — 11 of
    /// the sampled candidate scripts pass exactly this to `xmllint`.
    #[test]
    fn text_inside_a_command_string_is_not_a_call_site() {
        let src = "const r = await Promise.all([tools.exec_command({cmd: \"xmllint --html --xpath '//div//text()' -\"}), tools.exec_command({cmd:\"b\"})]);\nfor (const x of r) { text(x.output); text(\"done\"); }\n";
        assert_eq!(parse_code_mode_script(src).text_run, Some(2));
    }

    #[test]
    fn a_script_that_prints_nothing_has_no_run() {
        let src = "await tools.exec_command({cmd: \"a\"});";
        assert_eq!(parse_code_mode_script(src).text_run, None);
    }

    #[test]
    fn tools_reference_inside_a_string_is_not_a_call_site() {
        let src = "const r = await tools.exec_command({cmd: \"echo 'tools.exec_command({cmd:1})'\"}); text(r.output)";
        let got = calls(src);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].input_preview, "echo 'tools.exec_command({cmd:1})'");
    }

    #[test]
    fn shorthand_properties_do_not_resolve() {
        let src = "const results = await Promise.all(cmds.map(({cmd, workdir}) => tools.exec_command({cmd, workdir, yield_time_ms: 10000})));";
        let parsed = parse_code_mode_script(src);
        assert!(parsed.calls.is_none());
        assert_eq!(parsed.call_sites, 1);
    }

    #[test]
    fn identifier_argument_without_declaration_does_not_resolve() {
        let src = "const results = await Promise.all(cmds.map(c => tools.exec_command(c)));";
        assert!(parse_code_mode_script(src).calls.is_none());
    }

    #[test]
    fn template_interpolation_does_not_resolve() {
        let src = "const r = await tools.exec_command({cmd: `sed -n '1,${n}p' f`}); text(r.output)";
        assert!(parse_code_mode_script(src).calls.is_none());
    }

    #[test]
    fn script_without_tool_calls_does_not_resolve() {
        let parsed = parse_code_mode_script("text('hello');\n");
        assert!(parsed.calls.is_none());
        assert_eq!(parsed.call_sites, 0);
        assert_eq!(parsed.summary, None);
    }

    #[test]
    fn summary_falls_back_to_a_literal_command_when_calls_do_not_resolve() {
        let src = "const cmds = [\n  {cmd: \"cargo test\", workdir: \"/repo\"},\n  {cmd: \"cargo clippy\", workdir: \"/repo\"}\n];\nconst rs = await Promise.all(cmds.map(c => tools.exec_command(c)));";
        let parsed = parse_code_mode_script(src);
        assert!(parsed.calls.is_none());
        assert_eq!(parsed.summary.as_deref(), Some("cargo test"));
    }

    #[test]
    fn summary_uses_the_first_command_line() {
        let src = "const r = await tools.exec_command({cmd: \"cd /repo\\nmake build\"});";
        assert_eq!(
            parse_code_mode_script(src).summary.as_deref(),
            Some("cd /repo")
        );
    }

    #[test]
    fn completed_envelope_is_stripped_per_chunk() {
        let output = serde_json::json!([
            {"type": "input_text", "text": "Script completed\nWall time 0.5 seconds\nOutput:\n"},
            {"type": "input_text", "text": "first"},
            {"type": "input_text", "text": "second"},
        ]);
        let parsed = split_code_mode_output(Some(&output));
        assert_eq!(parsed.status, ScriptStatus::Completed);
        assert_eq!(parsed.chunks, vec!["first", "second"]);
        assert_eq!(parsed.note, None);
        assert!(!parsed.is_error());
    }

    #[test]
    fn failed_envelope_marks_the_result_as_an_error() {
        let output = serde_json::json!([
            {"type": "input_text", "text": "Script failed\nWall time 0.0 seconds\nOutput:\n"},
            {"type": "input_text", "text": "Script error:\nexec_command failed for `ls`"},
        ]);
        let parsed = split_code_mode_output(Some(&output));
        assert_eq!(parsed.status, ScriptStatus::Failed);
        assert!(parsed.is_error());
        assert!(parsed.joined().starts_with("Script error:"));
    }

    #[test]
    fn running_envelope_keeps_the_cell_note() {
        let output = serde_json::json!([
            {"type": "input_text", "text": "Script running with cell ID 56\nWall time 11.0 seconds\nOutput:\n"},
            {"type": "input_text", "text": "building…"},
        ]);
        let parsed = split_code_mode_output(Some(&output));
        assert_eq!(parsed.status, ScriptStatus::Running);
        assert_eq!(parsed.note.as_deref(), Some("Script running with cell ID 56"));
        assert_eq!(parsed.chunks, vec!["building…"]);
    }

    #[test]
    fn aborted_envelope_is_an_error_with_no_output() {
        let output = serde_json::json!("aborted by user after 3s");
        let parsed = split_code_mode_output(Some(&output));
        assert_eq!(parsed.status, ScriptStatus::Aborted);
        assert!(parsed.is_error());
        assert!(parsed.chunks.is_empty());
        assert_eq!(parsed.note.as_deref(), Some("aborted by user after 3s"));
    }

    #[test]
    fn plain_string_output_is_a_single_chunk() {
        let output = serde_json::json!("Script completed\nWall time 0.1 seconds\nOutput:\nhello");
        let parsed = split_code_mode_output(Some(&output));
        assert_eq!(parsed.chunks, vec!["hello"]);
    }

    #[test]
    fn output_without_an_envelope_is_left_alone() {
        let output = serde_json::json!("just text");
        let parsed = split_code_mode_output(Some(&output));
        assert_eq!(parsed.status, ScriptStatus::Unknown);
        assert_eq!(parsed.chunks, vec!["just text"]);
    }

    /// One call SITE is not one invocation, and arguments reached through a
    /// variable are only that variable's FIRST value — `job.cmd = cmd` inside a
    /// loop runs commands this scanner never sees. `args_inline` is what
    /// separates a recovered command that provably ran from one that is a
    /// guess; only the former may be credited with a background session.
    #[test]
    fn arguments_reached_through_a_variable_are_not_proof_of_what_ran() {
        let mutated = parse_code_mode_script(
            "const job = {cmd: \"pnpm build\"};\nfor (const cmd of [\"pnpm build\", \"pnpm dev\"]) {\n  job.cmd = cmd;\n  const r = await tools.exec_command(job);\n  text(JSON.stringify(r));\n}\n",
        );
        let calls = mutated.calls.expect("the identifier resolves");
        assert_eq!(calls[0].input_preview, "pnpm build");
        assert!(
            !calls[0].args_inline,
            "resolved through `job`, whose later value this scanner cannot see"
        );

        let inline = parse_code_mode_script(
            "const r = await tools.exec_command({cmd: \"pnpm dev\"});\ntext(r.output);\n",
        );
        let calls = inline.calls.expect("literal arguments resolve");
        assert!(calls[0].args_inline);

        // A literal that is only PART of the argument expression is not the
        // argument: `job` is what runs.
        let compound = parse_code_mode_script(
            "for (const job of jobs) {\n  const r = await tools.exec_command({cmd: \"pnpm build\"} && job);\n  text(r.output);\n}\n",
        );
        assert_eq!(compound.calls, None);
    }

    #[test]
    fn a_multi_call_script_that_does_not_resolve_recovers_no_calls() {
        let script = parse_code_mode_script(
            "await tools.exec_command({cmd: \"pnpm dev\", ...opts});\nawait tools.exec_command({cmd: \"cargo watch\", ...opts});\n",
        );
        assert_eq!(script.calls, None);
        assert_eq!(script.call_sites, 2);
    }

    #[test]
    fn session_ids_are_read_from_all_three_announcement_shapes() {
        assert_eq!(
            extract_shell_session_ids(
                "Chunk ID: 523e44\nWall time: 30.0 seconds\nProcess running with session ID 22068\nOutput:\n"
            ),
            vec!["22068"]
        );
        assert_eq!(
            extract_shell_session_ids("Script running with cell ID 56"),
            vec!["56"]
        );
        assert_eq!(
            extract_shell_session_ids(
                r#"{"chunk_id":"a74f94","wall_time_seconds":1.0,"session_id":7106,"output":""}"#
            ),
            vec!["7106"]
        );
        // Quoted value, same envelope.
        assert_eq!(
            extract_shell_session_ids(r#"{"chunk_id":"a7","session_id":"8"}"#),
            vec!["8"]
        );
    }

    /// A `wait` may address the cell by the envelope's hex chunk id instead of
    /// the numeric session id inside it. Both spellings appear in real
    /// transcripts for the same cell.
    #[test]
    fn chunk_ids_are_read_from_both_envelope_forms() {
        assert_eq!(
            extract_chunk_ids(
                "Chunk ID: 523e44\nWall time: 30.0 seconds\nProcess running with session ID 22068\nOutput:\n"
            ),
            vec!["523e44"]
        );
        assert_eq!(
            extract_chunk_ids(
                r#"{"chunk_id":"8716ba","wall_time_seconds":1.0,"session_id":13185,"output":""}"#
            ),
            vec!["8716ba"]
        );
        assert!(extract_chunk_ids("no envelope here").is_empty());
    }

    #[test]
    fn several_announcements_keep_order_and_collapse_duplicates() {
        let text = "Process running with session ID 10\nScript running with cell ID 11\nProcess running with session ID 10";
        assert_eq!(extract_shell_session_ids(text), vec!["10", "11"]);
    }

    #[test]
    fn text_that_merely_mentions_a_session_id_announces_nothing() {
        // Every one of these is a real shape seen in command output — a wrong
        // mapping would put someone else's command in a `wait` card's title.
        for text in [
            // Prose about sessions, not codex's own wording.
            "Connection established with agent-assigned session ID\n   4242",
            // A markdown heading followed by a numbered line.
            "### Streamable HTTP with Session ID\n    17",
            // Source code printed by a grep — the JSON key with no envelope.
            "src/x.rs:12:    json!({ \"session_id\": 1 })",
            "sessionIdRef.current = connSessionId\n   99",
        ] {
            assert!(
                extract_shell_session_ids(text).is_empty(),
                "false positive on {text:?}"
            );
        }
    }

    #[test]
    fn note_is_appended_to_the_output_blob() {
        assert_eq!(
            with_note(Some("out".to_string()), Some("still running")).as_deref(),
            Some("out\n\nstill running")
        );
        assert_eq!(
            with_note(Some("  ".to_string()), Some("still running")).as_deref(),
            Some("still running")
        );
        assert_eq!(with_note(None, None), None);
    }

    #[test]
    fn unicode_escapes_decode_including_surrogate_pairs() {
        let src = r#"const r = await tools.exec_command({cmd: "echo 你好 🚀"});"#;
        assert_eq!(calls(src)[0].input_preview, "echo 你好 🚀");
    }

    #[test]
    fn script_card_input_carries_source_title_and_count() {
        let json: Value =
            serde_json::from_str(&script_card_input("const a = 1", Some("ls"), 3)).unwrap();
        assert_eq!(json["source"], "const a = 1");
        assert_eq!(json["title"], "ls");
        assert_eq!(json["call_count"], 3);
    }
}
