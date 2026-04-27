/**
 * Module augmentation for next-auth v5 (Auth.js).
 *
 * Adds the custom claims we set on the JWT in `auth.ts` (jwt callback) and
 * project them onto the resolved Session, so consumers (`session.accessToken`,
 * `session.bypass`, etc.) are typed without `as any` casts.
 *
 * NOTE: next-auth v5 re-exports its types from `@auth/core/*`, so the
 * augmentations have to target THOSE modules — augmenting `next-auth` /
 * `next-auth/jwt` would land on the re-export shim, not the underlying
 * interfaces TypeScript actually resolves the JWT and Session types to.
 */

import type { DefaultSession } from "@auth/core/types";

declare module "@auth/core/types" {
  interface Session {
    accessToken?: string;
    login?: string;
    bypass?: boolean;
    user?: DefaultSession["user"];
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    accessToken?: string;
    login?: string;
    bypass?: boolean;
    bypass_iat?: number;
  }
}
