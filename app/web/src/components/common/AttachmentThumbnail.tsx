import { useState } from "react";
import { FileText, ImageIcon, X } from "lucide-react";
import { Button } from "../ui/button.tsx";
import { IconButton } from "./IconButton.tsx";
import { ImageLightbox } from "./ImageLightbox.tsx";
import { Spinner } from "./load.tsx";

function formatAttachmentBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

/**
 * @component AttachmentThumbnail
 * @purpose One attached file as a small square card: the picture itself for an
 * image, a file glyph and the extension otherwise.
 * @useWhen Showing a prompt's file attachments — staged in the composer, and on
 * the sent message in the transcript. Both use this card so an attachment looks
 * the same before and after sending.
 * @avoidWhen A context attachment (Task, project, file context): those are
 * navigable chips, not files.
 * @intent The name and size travel as the tooltip and accessible name rather
 * than as text under the tile, so a row of attachments stays one compact line on
 * a phone. An image opens full size on click; `uploading` dims the tile under a
 * spinner while the bytes are still on their way.
 */
export function AttachmentThumbnail({
  name,
  mimeType,
  size,
  src,
  uploading = false,
  onRemove,
}: {
  name: string;
  mimeType: string;
  size: number;
  /** The image to show; absent for a non-image or one whose bytes are gone. */
  src?: string | undefined;
  uploading?: boolean;
  /** Offered in the composer, where a staged attachment can be dropped. */
  onRemove?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  // The picture the server could not answer (a saved prompt's image whose
  // bytes are gone): that tile falls back to the named file glyph and offers
  // no lightbox, rather than a broken image that opens an empty one. Keyed by
  // the URL, so a new source tries again.
  const [failedSrc, setFailedSrc] = useState<string>();
  const isImage = mimeType.startsWith("image/");
  const picture = isImage && src && failedSrc !== src ? src : undefined;
  const label = `${name} · ${formatAttachmentBytes(size)}`;
  const extension = name.includes(".")
    ? name.slice(name.lastIndexOf(".") + 1).slice(0, 5)
    : "";
  const tile = (
    <>
      {picture ? (
        <img
          src={picture}
          alt=""
          className="size-full object-cover"
          onError={() => setFailedSrc(picture)}
        />
      ) : (
        <span className="flex size-full flex-col items-center justify-center gap-1 text-muted-foreground">
          {isImage ? <ImageIcon size={18} /> : <FileText size={18} />}
          {extension ? (
            <span className="max-w-full truncate px-1 text-xs uppercase">
              {extension}
            </span>
          ) : null}
        </span>
      )}
      {uploading ? (
        <span className="absolute inset-0 flex items-center justify-center bg-background/60">
          <Spinner size="sm" />
        </span>
      ) : null}
    </>
  );
  const frame =
    "relative block size-16 shrink-0 overflow-hidden rounded-lg border bg-muted";
  return (
    <div className="relative shrink-0" title={label}>
      {picture ? (
        <Button
          variant="ghost"
          // The tile IS the button: the frame's fixed 64px square (a portrait
          // image must not stretch it), no padding, and the muted frame stays
          // put on hover.
          className={`${frame} h-16 cursor-zoom-in p-0 hover:bg-muted`}
          aria-label={`Open ${label}`}
          onClick={() => setOpen(true)}
        >
          {tile}
        </Button>
      ) : (
        <div className={frame} role="img" aria-label={label}>
          {tile}
        </div>
      )}
      {onRemove ? (
        <IconButton
          label={`Remove ${name}`}
          size="icon-xs"
          variant="secondary"
          className="absolute -top-1.5 -right-1.5 rounded-full border shadow-sm"
          onClick={onRemove}
        >
          <X />
        </IconButton>
      ) : null}
      {open && picture ? (
        <ImageLightbox
          src={picture}
          alt={name}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}
