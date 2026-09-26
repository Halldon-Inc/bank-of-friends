import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "The First Bank of Friends",
  description:
    "Sign once. The bank's keeper claims your Rare Friend's RF and WETH rewards into your own safe deposit box, its swap desk trades the pooled funds when a move pays even after the 5% toll both ways, and you take everything home with a receipt, any time.",
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
