/**
 * A small OpenID Connect provider for the server's tests: discovery, an
 * authorization endpoint that signs the configured person in at once (or
 * says no), the token endpoint (authorization code with PKCE), and its keys.
 * Tests change what it does next: who signs in, a tampered ID token, an
 * endpoint that fails, keys that rotate.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface MockOidcOptions {
  clientId: string
  clientSecret?: string
  /** What the provider says it takes at its token endpoint (client_secret_basic by default). */
  authMethods?: string[]
  /** How it signs ID tokens. */
  algorithm?: 'RS256' | 'ES256'
}

/** A change to the next ID token. */
export interface Tamper {
  claims?: Record<string, unknown>
  header?: Record<string, unknown>
  /** Signed with a key the provider doesn't publish. */
  foreignKey?: boolean
  /** Sent instead of an ID token. */
  idToken?: unknown
}

export interface MockOidc {
  issuer: string
  /** The claims of whoever signs in next. */
  person: Record<string, unknown>
  /** Whether the authorization endpoint says no (access_denied) next. */
  refuse: boolean
  tamper?: Tamper
  /** Endpoints that answer 500 until removed. */
  failing: Set<'discovery' | 'jwks' | 'token'>
  /** Signs with a new key from now on, and publishes only that one. */
  rotateKeys(): void
  /** What the token endpoint was sent. */
  tokenRequests: { authorization?: string; body: URLSearchParams }[]
  close(): Promise<void>
}

interface Key {
  kid: string
  privateKey: KeyObject
  publicKey: KeyObject
}

function newKey(algorithm: 'RS256' | 'ES256'): Key {
  const pair =
    algorithm === 'RS256'
      ? generateKeyPairSync('rsa', { modulusLength: 2048 })
      : generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return { kid: randomBytes(6).toString('hex'), ...pair }
}

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

export async function startMockOidc(options: MockOidcOptions): Promise<MockOidc> {
  const algorithm = options.algorithm ?? 'RS256'
  let key = newKey(algorithm)
  const foreign = newKey(algorithm)
  /** Codes handed out, and what they stand for. */
  const codes = new Map<string, { challenge: string; nonce: string; redirectUri: string }>()

  const idToken = (nonce: string, tamper: Tamper = {}) => {
    const now = Math.floor(Date.now() / 1000)
    const header = { alg: algorithm, typ: 'JWT', kid: key.kid, ...tamper.header }
    const claims = {
      iss: provider.issuer,
      aud: options.clientId,
      iat: now,
      exp: now + 300,
      nonce,
      ...provider.person,
      ...tamper.claims,
    }
    const signed = `${encode(header)}.${encode(claims)}`
    const signer = tamper.foreignKey ? foreign.privateKey : key.privateKey
    const signature = sign('sha256', Buffer.from(signed), {
      key: signer,
      ...(algorithm === 'ES256' ? { dsaEncoding: 'ieee-p1363' as const } : {}),
    })
    return `${signed}.${signature.toString('base64url')}`
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, provider.issuer)
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
    }
    const failing = (what: 'discovery' | 'jwks' | 'token') => {
      if (!provider.failing.has(what)) return false
      json(500, { error: 'server_error' })
      return true
    }
    if (url.pathname === '/.well-known/openid-configuration') {
      if (failing('discovery')) return
      json(200, {
        issuer: provider.issuer,
        authorization_endpoint: `${provider.issuer}/authorize`,
        token_endpoint: `${provider.issuer}/token`,
        jwks_uri: `${provider.issuer}/keys`,
        ...(options.authMethods
          ? { token_endpoint_auth_methods_supported: options.authMethods }
          : {}),
      })
    } else if (url.pathname === '/keys') {
      if (failing('jwks')) return
      json(200, {
        keys: [{ ...key.publicKey.export({ format: 'jwk' }), kid: key.kid, use: 'sig' }],
      })
    } else if (url.pathname === '/authorize') {
      const params = url.searchParams
      const back = new URL(params.get('redirect_uri')!)
      back.searchParams.set('state', params.get('state')!)
      if (provider.refuse) {
        provider.refuse = false
        back.searchParams.set('error', 'access_denied')
      } else {
        const code = randomBytes(16).toString('base64url')
        codes.set(code, {
          challenge: params.get('code_challenge')!,
          nonce: params.get('nonce')!,
          redirectUri: params.get('redirect_uri')!,
        })
        back.searchParams.set('code', code)
      }
      res.writeHead(302, { Location: back.href }).end()
    } else if (url.pathname === '/token' && req.method === 'POST') {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
        provider.tokenRequests.push({ authorization: req.headers.authorization, body })
        if (failing('token')) return
        const grant = codes.get(body.get('code') ?? '')
        codes.delete(body.get('code') ?? '')
        const verifier = createHash('sha256')
          .update(body.get('code_verifier') ?? '')
          .digest('base64url')
        const basic = `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64')}`
        const authenticated =
          options.clientSecret === undefined ||
          req.headers.authorization === basic ||
          body.get('client_secret') === options.clientSecret
        if (
          !grant ||
          !authenticated ||
          grant.challenge !== verifier ||
          grant.redirectUri !== body.get('redirect_uri')
        ) {
          json(400, { error: 'invalid_grant' })
          return
        }
        const tamper = provider.tamper
        provider.tamper = undefined
        json(200, {
          access_token: randomBytes(16).toString('hex'),
          token_type: 'Bearer',
          id_token: tamper && 'idToken' in tamper ? tamper.idToken : idToken(grant.nonce, tamper),
        })
      })
    } else {
      json(404, { error: 'not_found' })
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  const provider: MockOidc = {
    issuer: `http://127.0.0.1:${port}`,
    person: {},
    refuse: false,
    failing: new Set(),
    tokenRequests: [],
    rotateKeys() {
      key = newKey(algorithm)
    },
    close() {
      server.closeAllConnections()
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
  return provider
}
