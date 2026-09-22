import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "The First Bank of Friends",
  description:
    "Sign once. The bank's keeper claims your Rare Friend's rewards into its own safe deposit box, in kind, and a maker-only desk becomes the liquidity the pool never had. Withdraw either asset any time.",
  openGraph: {
    title: "The First Bank of Friends",
    description: "Sign once. Your Friend banks its own rewards, forever.",
    type: "website",
  },
  twitter: { card: "summary_large_image", title: "The First Bank of Friends", description: "Sign once. Your Friend banks its own rewards, forever." },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
