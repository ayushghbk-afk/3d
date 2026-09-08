/** Keep email callbacks inside the deployed directory, including /3d/ on Pages.
 * Strip router hashes, auth tokens, and query strings from the callback target.
 */
export function appUrl(href = window.location.href): string {
  return new URL('./', href).href;
}
