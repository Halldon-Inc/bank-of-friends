import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "The First Bank of Friends",
  description:
    "A regime-gated market-making desk funded by the rewards sitting idle in Rare Friends NFT wallets. Flat by default.",
  openGraph: {
    title: "The First Bank of Friends",
    description: "A desk that is flat until the market pays it.",
    type: "website",
  },
  twitter: { card: "summary_large_image", title: "The First Bank of Friends", description: "A desk that is flat until the market pays it." },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
