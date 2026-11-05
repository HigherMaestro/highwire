import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "../../components/Chrome.tsx";
import { SignApp } from "../../components/sign/SignApp.tsx";

// Static shell; everything else happens in the browser (components/sign).
// next.config.ts gives this route its own strict security headers.

export const metadata: Metadata = {
  title: "Sign",
  description: "Review, simulate and sign a transaction Highwire built, in your own wallet. Nothing is sent to Highwire.",
  alternates: { canonical: "/sign" },
  // Sign links are personal and short-lived; nothing here is worth indexing.
  robots: { index: false, follow: false },
};

export default function SignPage() {
  return (
    <>
      <SiteHeader />
      <main className="sign">
        <div className="wrap sign-wrap">
          <SignApp />
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
