import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Medrella | Healthcare appointments, made simpler",
  description: "Find a doctor, book your appointment, and manage your appointments in one place.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased scroll-smooth`}
    >
      <body className="min-h-full flex flex-col">
        
{/* import { ClerkProvider } from "@clerk/nextjs"; */}

<ClerkProvider
  appearance={{
    variables: {
      colorPrimary: "var(--primary)",
      colorBackground: "var(--card)",
      colorForeground: "var(--card-foreground)",
      colorMutedForeground: "var(--muted-foreground)",
      colorInput: "var(--card)",
      colorInputForeground: "var(--card-foreground)",
      // colorBorder: "var(--border)",
      colorRing: "var(--ring)",
      colorDanger: "var(--destructive)",
      colorSuccess: "var(--status-confirmed)",
      colorWarning: "var(--status-pending)",
      borderRadius: "var(--radius)",
      fontFamily: "Arial, Helvetica, sans-serif",
    },
  }}
>
  {children}
  <Toaster position="top-right" />
</ClerkProvider>

      </body>
    </html>
  );
}
