import { JiraCredentialsSchema, type JiraCredentials } from '@brigadir/contracts';
import { JiraAuthError } from './jira.errors';

/**
 * Encode/decode `workspaces.jira_credentials` (bytea). Iteration 2 stores a JSON
 * blob `{email, api_token}`; AES-256-GCM encryption is a later concern and slots
 * in here without touching callers. A blob that is not decodable/valid (e.g. the
 * iteration-1 placeholder bytes) raises `JiraAuthError` — unrecoverable, not a
 * silent fallback (Constitution V / lazy-resolution).
 */
export function encodeJiraCredentials(creds: JiraCredentials): Buffer {
  return Buffer.from(JSON.stringify(JiraCredentialsSchema.parse(creds)), 'utf8');
}

export function decodeJiraCredentials(blob: Buffer | Uint8Array): JiraCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(blob).toString('utf8'));
  } catch {
    throw new JiraAuthError(
      'workspace jira_credentials are not a valid credentials blob (expected {email, api_token})',
    );
  }
  const result = JiraCredentialsSchema.safeParse(parsed);
  if (!result.success) {
    throw new JiraAuthError(
      `workspace jira_credentials failed validation: ${result.error.issues
        .map((i) => i.path.join('.') || '<root>')
        .join(', ')}`,
    );
  }
  return result.data;
}
