import { json } from './http.js';

const encoder = new TextEncoder();

async function tokenDigest(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

async function tokenMatches(candidate, expected) {
  const [candidateDigest, expectedDigest] = await Promise.all([
    tokenDigest(candidate),
    tokenDigest(expected),
  ]);
  let different = 0;
  for (let index = 0; index < expectedDigest.length; index += 1) {
    different |= candidateDigest[index] ^ expectedDigest[index];
  }
  return different === 0;
}

export async function authenticate(request, env) {
  const accounts = [
    { username: 'ralph', identity: 'Ralph', password: env.BOARD_PASSWORD_RALPH },
    { username: 'agents', identity: 'AI', password: env.BOARD_PASSWORD_AGENTS },
  ];

  if (accounts.some(({ password }) => !password)) {
    return {
      response: json(
        {
          error: 'Board authentication is not configured. Set both board passwords.',
        },
        500,
      ),
    };
  }

  const header = request.headers.get('authorization') || '';
  const match = /^Basic\s+(.+)$/i.exec(header);
  if (!match) {
    return {
      response: json({ error: 'Enter a valid username and password.' }, 401, {
        'WWW-Authenticate': 'Basic realm="Spoolcast board", charset="UTF-8"',
      }),
    };
  }

  let supplied = '';
  try {
    supplied = atob(match[1]);
  } catch {
    // The same generic response is returned for every invalid credential.
  }

  const separator = supplied.indexOf(':');
  const username = separator === -1 ? '' : supplied.slice(0, separator).toLowerCase();
  const password = separator === -1 ? '' : supplied.slice(separator + 1);
  const account = accounts.find((candidate) => candidate.username === username);

  if (account && (await tokenMatches(password, account.password))) {
    return { identity: account.identity, username: account.username };
  }

  return {
    response: json({ error: 'Enter a valid username and password.' }, 401, {
      'WWW-Authenticate': 'Basic realm="Spoolcast board", charset="UTF-8"',
    }),
  };
}
