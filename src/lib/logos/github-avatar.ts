/** Accept only the numeric owner-avatar URLs returned by GitHub's repository API. */
export function validateGitHubAvatarUrl(value: string, expectedOwnerId: number | string): string {
  const ownerId = String(expectedOwnerId);
  if (!/^[1-9][0-9]{0,18}$/.test(ownerId)) throw new TypeError("GitHub owner identity is invalid.");

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("GitHub avatar URL is invalid.");
  }

  if (url.protocol !== "https:" || url.hostname !== "avatars.githubusercontent.com"
    || url.port || url.username || url.password || url.hash
    || url.pathname !== `/u/${ownerId}`
    || (url.search && (!/^\?v=[0-9]{1,4}$/.test(url.search)))
    || url.href !== value) {
    throw new TypeError("GitHub avatar URL is outside the validated GitHub avatar format.");
  }
  return url.href;
}
