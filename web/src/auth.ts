import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { isBypassSessionExpired } from "@/lib/bypass";

/**
 * Auth.js v5 — GitHub provider only.
 * `repo` scope is required so we can read private PRs the user has access to
 * and post real PR reviews on their behalf.
 * No database — everything lives on the GitHub session token (JWT).
 *
 * The test-mode bypass route (/api/test-bootstrap) sets the same cookie
 * shape used by GitHub OAuth, but with a `bypass: true` and `bypass_iat`
 * claim. The session callback checks bypass_iat against the 30-min cap
 * and clears the access token on stale bypass sessions (functional
 * logout without needing to delete the cookie). Write-capable server
 * actions also refuse to run when `session.bypass === true`.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    GitHub({
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      authorization: { params: { scope: "read:user user:email repo" } },
    }),
  ],
  session: { strategy: "jwt" },
  callbacks: {
    async jwt({ token, account, profile }) {
      if (account?.access_token) token.accessToken = account.access_token;
      if (profile?.login) token.login = profile.login as string;
      return token;
    },
    async session({ session, token }) {
      // Bypass-minted sessions are capped at BYPASS_SESSION_MAX_AGE_S
      // (30 min) regardless of what the cookie itself says. Past the
      // window, we drop the access token from the resolved session so
      // every server action sees "not signed in".
      if (token.bypass && isBypassSessionExpired(token.bypass_iat)) {
        return session;
      }
      session.accessToken = token.accessToken;
      session.login = token.login;
      session.bypass = token.bypass === true;
      return session;
    },
  },
  trustHost: true,
});
