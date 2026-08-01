/** Enough to identify the failure, short enough that a long tail of run-specific
 *  noise cannot make two identical failures look different. */
const SIGNATURE_CHARS = 160;

export function errorSignature(message: string): string {
  return message
    .replace(/0x[0-9a-f]+/gi, '')            // hex addresses
    .replace(/\b\d+(?:\.\d+)?m?s\b/gi, '')   // durations
    .replace(/[A-Za-z]:[\\/][^\s:)]*/g, '')  // Windows absolute paths
    .replace(/(?:\/[\w.@-]+){2,}/g, '')      // POSIX absolute paths
    .replace(/:\d+(?::\d+)?/g, '')           // line:column
    .replace(/\b\d+\b/g, '')                 // remaining bare numbers
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, SIGNATURE_CHARS);
}
