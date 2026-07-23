/**
 * Git auth for private template repos (feature 030, research D4). A token is
 * delivered to the git child process ONLY through ephemeral `GIT_CONFIG_*`
 * environment variables — never in argv (visible in `ps`), never written into
 * the repo's persisted `.git/config`, never in the agent's environment. The
 * value is an `Authorization: Basic …` header applied for the one clone/fetch.
 *
 * SSH remotes ignore the token (they authenticate with the host's ambient SSH
 * agent); passing a token there is a no-op.
 */

/** True for `https://…` URLs (the only scheme a token applies to). */
function isHttpsUrl(url: string): boolean {
  return /^https:\/\//i.test(url);
}

/**
 * The child-process env carrying the token as an HTTP Authorization header via
 * git's ephemeral config mechanism. Returns `{}` for non-https URLs or no token.
 */
export function gitAuthEnv(url: string, token: string | undefined): Record<string, string> {
  if (!token || !isHttpsUrl(url)) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    // Belt-and-suspenders: never let git prompt for credentials interactively.
    GIT_TERMINAL_PROMPT: '0',
  };
}
