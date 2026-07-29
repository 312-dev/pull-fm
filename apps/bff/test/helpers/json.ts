/**
 * Typed access to an injected response body.
 *
 * `light-my-request` types `json()` as `any`, so an inline `as T` at the call
 * site is both a lint error and a lie: nothing is being narrowed. Doing the
 * cast once, from `unknown`, keeps the assertion honest and confines it to a
 * single place a reviewer can check.
 */

export function jsonOf<T>(response: { json: () => T }): T {
  return response.json();
}
