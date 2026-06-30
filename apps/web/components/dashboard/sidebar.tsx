'use client';

import { cn } from '@/lib/utils';
import {
  LayoutDashboard,
  Building2,
  BarChart3,
  FileText,
  Settings,
  Leaf,
  ChevronLeft,
  ChevronRight,
  ClipboardEdit,
} from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const navItems = [
  { id: 'overview', label: 'Dashboard', icon: LayoutDashboard, href: '/' },
  { id: 'data-entry', label: 'Data Entry', icon: ClipboardEdit, href: '/data-entry' },
  { id: 'subsidiaries', label: 'Subsidiaries', icon: Building2, href: '/subsidiaries' },
  { id: 'emissions', label: 'Emissions', icon: BarChart3, href: '/emissions' },
  { id: 'reports', label: 'Reports', icon: FileText, href: '/reports' },
];

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();

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
              <span className="text-xs font-medium text-[#6E6E73]">Sustainability Platform</span>
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
                {!collapsed && <span>{item.label}</span>}
              </Link>
            );

            if (collapsed) {
              return (
                <Tooltip key={item.id}>
                  <TooltipTrigger asChild>{linkContent}</TooltipTrigger>
                  <TooltipContent side="right" className="bg-[#1D1D1F] text-white border-0 font-semibold shadow-lg">
                    {item.label}
                  </TooltipContent>
                </Tooltip>
              );
            }

            return linkContent;
          })}
        </nav>

        {/* Settings & Collapse */}
        <div className="border-t border-[#D8D8DC] p-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-sm font-semibold text-[#1D1D1F] transition-all duration-200 hover:bg-[#E0E0E5]"
              >
                <Settings className="h-5 w-5 shrink-0 text-[#6E6E73]" />
                {!collapsed && <span>Settings</span>}
              </button>
            </TooltipTrigger>
            {collapsed && (
              <TooltipContent side="right" className="bg-[#1D1D1F] text-white border-0 font-semibold shadow-lg">
                Settings
              </TooltipContent>
            )}
          </Tooltip>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => setCollapsed(!collapsed)}
            className="mt-2 w-full justify-center text-[#6E6E73] hover:text-[#1D1D1F] hover:bg-[#E0E0E5] font-semibold"
          >
            {collapsed ? <ChevronRight className="h-5 w-5" /> : <ChevronLeft className="h-5 w-5" />}
          </Button>
        </div>
      </aside>
    </TooltipProvider>
  );
}
