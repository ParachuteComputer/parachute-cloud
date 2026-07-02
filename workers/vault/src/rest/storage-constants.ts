/**
 * Storage upload policy — ported verbatim from parachute-vault/src/routes.ts
 * (vault#517). BLOCKED_EXTENSIONS is active/executable content only (blocked
 * because it runs as script served same-origin); everything else is accepted
 * and served as a download (octet-stream + nosniff).
 */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100MB

export const BLOCKED_EXTENSIONS = new Set([
  ".html", ".htm", ".xhtml", ".shtml", ".xht",
  ".svg",
  ".xml",
  ".js", ".mjs", ".cjs",
  ".css",
]);

export const MIME_TYPES: Record<string, string> = {
  // Audio
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/opus",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".webm": "audio/webm",
  // Image
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".avif": "image/avif",
  // Video
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  // Documents / ebooks / data
  ".pdf": "application/pdf",
  ".epub": "application/epub+zip",
  ".mobi": "application/x-mobipocket-ebook",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".rtf": "application/rtf",
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".zip": "application/zip",
};

/** Lowercased extension of a filename (incl. leading dot), or "". */
export function extLower(name: string): string {
  const base = name.replace(/[.\s]+$/, "");
  const slash = base.lastIndexOf("/");
  const dot = base.lastIndexOf(".");
  if (dot <= slash || dot < 0) return "";
  return base.slice(dot).toLowerCase();
}
