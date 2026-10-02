/**
 * Single sign-on with OpenID Connect: the authorization code flow with PKCE.
 * The provider says who someone is, and which groups they're in; the server
 * then acts as them in the cluster (see cluster.ts), so their RBAC applies.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { SessionUser } from '@shared/server'
import type { AuthConfig } from './config'
import { keyId, verifyIdToken, type Jwk } from './jwt'

type OidcConfig = Extract<AuthConfig, { mode: 'oidc' }>

interface Discovery {
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  token_endpoint_auth_methods_supported?: string[]
}

/** A sign-in on its way through the provider. */
export interface PendingSignIn {
  state: string
  verifier: string
  nonce: string
  /** Where in the app to go once signed in. */
  then: string
}

const TIMEOUT_MS = 20_000

const random = () => randomBytes(32).toString('base64url')

export class OidcClient {
  #discovery?: Promise<Discovery>
  #keys?: Promise<Jwk[]>

  constructor(
    private readonly config: OidcConfig,
    /** Where the provider sends people back to. */
    private readonly redirectUri: string,
  ) {}

  /** Starts a sign-in: where to send the browser, and what to remember until it's back. */
  async start(then: string): Promise<{ url: string; pending: PendingSignIn }> {
    const pending = { state: random(), verifier: random(), nonce: random(), then }
    const url = new URL((await this.#discover()).authorization_endpoint)
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.redirectUri,
      scope: this.config.scopes,
      state: pending.state,
      nonce: pending.nonce,
      code_challenge: createHash('sha256').update(pending.verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString()
    return { url: url.href, pending }
  }

  /** Finishes a sign-in: trades the code for an ID token, and says who it names. */
  async finish(code: string, pending: PendingSignIn): Promise<SessionUser> {
    const discovery = await this.#discover()
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      code_verifier: pending.verifier,
      client_id: this.config.clientId,
    })
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
    const { clientSecret } = this.config
    if (clientSecret) {
      // HTTP Basic unless the provider only takes the secret in the body.
      if (
        discovery.token_endpoint_auth_methods_supported?.includes('client_secret_basic') === false
      ) {
        body.set('client_secret', clientSecret)
      } else {
        const credentials = `${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(clientSecret)}`
        headers.Authorization = `Basic ${Buffer.from(credentials).toString('base64')}`
      }
    }
    const tokens = (await fetchJson(discovery.token_endpoint, {
      method: 'POST',
      headers,
      body,
    })) as {
      id_token?: unknown
    }
    if (typeof tokens.id_token !== 'string') throw new Error('The provider sent no ID token')
    const token = tokens.id_token
    let keys = await this.#jwks()
    // A provider that rotated its keys signs with one not seen yet.
    if (!keys.some((key) => keyId(token) === undefined || key.kid === keyId(token))) {
      keys = await this.#jwks(true)
    }
    const claims = verifyIdToken(token, keys, {
      issuer: this.config.issuer,
      audience: this.config.clientId,
      nonce: pending.nonce,
    })
    const name = claims[this.config.usernameClaim]
    if (typeof name !== 'string' || name === '') {
      throw new Error(`The ID token has no ${this.config.usernameClaim} claim to name the user by`)
    }
    const groups = ([] as unknown[]).concat(claims[this.config.groupsClaim] ?? [])
    return { name, groups: groups.filter((group): group is string => typeof group === 'string') }
  }

  #discover(): Promise<Discovery> {
    this.#discovery ??= (
      fetchJson(`${this.config.issuer}/.well-known/openid-configuration`) as Promise<Discovery>
    ).catch((error: unknown) => {
      // Asked again next time: the provider may just have been down.
      this.#discovery = undefined
      throw error
    })
    return this.#discovery
  }

  #jwks(refresh = false): Promise<Jwk[]> {
    if (refresh || !this.#keys) {
      this.#keys = this.#discover()
        .then((discovery) => fetchJson(discovery.jwks_uri) as Promise<{ keys: Jwk[] }>)
        .then(({ keys }) => keys)
      this.#keys.catch(() => (this.#keys = undefined))
    }
    return this.#keys
  }
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(
    (error: Error) => {
      throw new Error(`Couldn’t reach ${url}: ${error.message}`)
    },
  )
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}: ${(await response.text()).slice(0, 300)}`)
  }
  return response.json()
}
