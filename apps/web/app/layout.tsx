import type { Metadata } from 'next'
import { Inter, JetBrains_Mono } from 'next/font/google'
import { Analytics } from '@vercel/analytics/next'
import { cookies, headers } from 'next/headers'
import { Toaster } from 'sonner'
import { I18nProvider } from '@/components/i18n/i18n-provider'
import { LOCALE_COOKIE, resolveLocale } from '@/lib/i18n/locale'
import { MESSAGES } from '@/messages'
import './globals.css'

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });

export const metadata: Metadata = {
  title: 'TonyAI - Enterprise Sustainability Data Platform',
  description: 'Professional data management platform for carbon accounting and ESG reporting',
  generator: 'v0.app',
  icons: {
    icon: [
      {
        url: '/icon-light-32x32.png',
        media: '(prefers-color-scheme: light)',
      },
      {
        url: '/icon-dark-32x32.png',
        media: '(prefers-color-scheme: dark)',
      },
      {
        url: '/icon.svg',
        type: 'image/svg+xml',
      },
    ],
    apple: '/apple-icon.png',
  },
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // LP3-01: the cookie (the profile's mirror), else the browser's languages,
  // else English. Only the chosen locale's catalogue reaches the client.
  const [cookieStore, headerList] = await Promise.all([cookies(), headers()])
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE)?.value, headerList.get('accept-language'))
  return (
    <html lang={locale}>
      <body className={`${inter.variable} ${jetbrainsMono.variable} font-sans antialiased`}>
        <I18nProvider locale={locale} messages={MESSAGES[locale]}>
          {children}
          <Toaster richColors position="bottom-right" />
        </I18nProvider>
        <Analytics />
      </body>
    </html>
  )
}
