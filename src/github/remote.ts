/* Parses both SSH and HTTPS remotes, and tolerates a trailing `.git`. */
export const parseRemote = (url: string) => {
  const cleaned = url.trim().replace(/\.git$/, "");
  const matched =
    /^git@[^:]+:([^/]+)\/(.+)$/.exec(cleaned) ??
    /^(?:https?|ssh):\/\/[^/]+\/([^/]+)\/(.+)$/.exec(cleaned);
  const owner = matched?.[1];
  const name = matched?.[2];
  return owner && name ? { owner, name } : undefined;
};
