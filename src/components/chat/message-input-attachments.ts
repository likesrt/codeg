/**
 * Shared attachment value types for the message input.
 *
 * Extracted from `message-input.tsx` so the host component and the composer's
 * send/restore serializers ({@link "./composer/to-prompt-blocks"} /
 * {@link "./composer/from-prompt-blocks"}) all agree on one definition rather
 * than re-declaring structurally-compatible copies.
 *
 * An attachment is content the user adds *out of band* of the prose — pasted /
 * dragged / uploaded / picked images and files. Inline references typed via the
 * `@` panel are NOT attachments; they live in the editor document as reference
 * badges. Both fold into the outgoing `PromptInputBlock[]` at send time.
 */

/** A file/resource attachment (a `file://` link, an uploaded blob, or an
 *  embedded text/binary resource). */
export interface ResourceInputAttachment {
  id: string
  type: "resource"
  /** `link` → sent as a ResourceLink (uri only); `embedded` → sent as a Resource
   *  carrying inline `text`/`blob`. */
  kind: "link" | "embedded"
  uri: string
  name: string
  mimeType: string | null
  text?: string | null
  blob?: string | null
}

/** An image attachment, held as base64 (no data-URI prefix). `uri` is the
 *  `file://` origin when added from a native path, else null. */
export interface ImageInputAttachment {
  id: string
  type: "image"
  data: string
  uri: string | null
  name: string
  mimeType: string
}

export type InputAttachment = ResourceInputAttachment | ImageInputAttachment
