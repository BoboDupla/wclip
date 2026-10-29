// Paywall-teaser detection. A 200 response is not proof of a complete article: WSJ-class
// sites serve the opening paragraphs plus a rights notice and a subscribe box, which
// extracts cleanly and produces a confident, useless two-paragraph note.
//
// The check is deliberately narrow (short article AND an explicit rights/paywall marker in
// its final block) so ordinary short posts, news briefs and legal pages do not trip it.
// It only ever warns; refusing to write would break legitimate pages and --stdout debugging.
export const TEASER_WORD_LIMIT = 400;

// Markers that a body ended at a rights notice rather than at the end of the story.
const RIGHTS_TAIL = /(?:©|\(c\)|copyright)\s*(?:\d{4}|©)|all rights reserved|dow jones & company|djreprints/i;
// Text that only ever appears in a "you cannot read this" frame.
const PAYWALL_MARKER = /this copy is for your personal|subscriber agreement|to continue reading|already a subscriber|subscribe now to (?:read|continue)/i;

function blocks(content: string): string[] {
  return content.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
}

// Why the extracted text looks truncated, or null when it does not.
export function teaserReason(content: string, words: number): string | null {
  if (words >= TEASER_WORD_LIMIT) return null;
  const parts = blocks(content);
  if (!parts.length) return null;
  const tail = parts.slice(-2).join('\n');
  if (PAYWALL_MARKER.test(tail)) return 'the body ends in a subscribe/login notice';
  if (RIGHTS_TAIL.test(parts[parts.length - 1])) return 'the body ends with a copyright notice';
  return null;
}
