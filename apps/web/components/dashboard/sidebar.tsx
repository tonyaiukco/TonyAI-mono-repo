'use client';

import { cn } from '@/lib/utils';
import { BarChart3, Building2, ChevronLeft, ChevronRight, ClipboardEdit, FileText, LayoutDashboard, Leaf, ScrollText, Stamp } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { LanguageSwitcher } from '@/components/i18n/language-switcher';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const navItems = [
  { id: 'overview', label: 'dashboard', icon: LayoutDashboard, href: '/' },
  { id: 'data-entry', label: 'dataEntry', icon: ClipboardEdit, href: '/data-entry' },
  { id: 'subsidiaries', label: 'subsidiaries', icon: Building2, href: '/subsidiaries' },
  { id: 'emissions', label: 'emissions', icon: BarChart3, href: '/emissions' },
  // Sits next to Emissions because that is where the records it decides live.
  // Shown to every role for the same reason as the audit item below: the page
  // explains who may review, which a missing nav entry cannot.
  { id: 'review', label: 'review', icon: Stamp, href: '/review' },
  { id: 'reports', label: 'reports', icon: FileText, href: '/reports' },
  // super_admin-only: the API 403s every other role, and the page says so
  // rather than hiding — a missing nav item reads as a bug to a tester.
  { id: 'audit', label: 'audit', icon: ScrollText, href: '/audit' },
] as const;

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();
  const t = useTranslations('nav');

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        className={cn(
          'fixed left-0 top-0 z-40 flex h-screen flex-col border-r border-[#D8D8DC] bg-[#EBEBF0] transition-all duration-300',
          collapsed ? 'w-16' : 'w-[280px]'
        )}
      >
        {/* Logo */}
        <div className="flex h-16 items-center gap-3 border-b border-[#D8D8DC] px-5">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#1B5E3B] shadow-sm">
            <Leaf className="h-5 w-5 text-white" />
          </div>
          {!collapsed && (
            <div className="flex flex-col">
              <span className="text-lg font-bold text-[#1D1D1F]">TonyAI</span>
              <span className="text-xs font-medium text-[#6E6E73]">{t('platform')}</span>
            </div>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-1 px-3 py-5">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
            
            const linkContent = (
              <Link
                key={item.id}
                href={item.href}
                className={cn(
                  'flex w-full items-center gap-3 rounded-xl px-4 py-3 text-sm font-semibold transition-all duration-200',
                  isActive
                    ? 'bg-[#1B5E3B] text-white'
                    : 'text-[#1D1D1F] hover:bg-[#E0E0E5]'
                )}
              >
                <Icon className={cn(
                  'h-5 w-5 shrink-0',
                  isActive ? 'text-white' : 'text-[#6E6E73]'
                )} />
                {!collapsed && <span>{t(item.label)}</span>}
              </Link>
            );

            if (collapsed) {
              return (
                <Tooltip key={item.id}>
                  <TooltipTrigger asChild>{linkContent}</TooltipTrigger>
                  <TooltipContent side="right" className="bg-[#1D1D1F] text-white border-0 font-semibold shadow-lg">
                    {t(item.label)}
                  </TooltipContent>
                </Tooltip>
              );
            }

            return linkContent;
          })}
        </nav>

        {/* Language & Collapse. The language switcher replaces a Settings
            button that had no handler (LP3-01). */}
        <div className="border-t border-[#D8D8DC] p-3">
          <LanguageSwitcher collapsed={collapsed} />

          <Button
            variant="ghost"
            size="sm"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? t('expand') : t('collapse')}
            className="mt-2 w-full justify-center text-[#6E6E73] hover:text-[#1D1D1F] hover:bg-[#E0E0E5] font-semibold"
          >
            {collapsed ? <ChevronRight className="h-5 w-5" /> : <ChevronLeft className="h-5 w-5" />}
          </Button>
        </div>
      </aside>
    </TooltipProvider>
  );
}
