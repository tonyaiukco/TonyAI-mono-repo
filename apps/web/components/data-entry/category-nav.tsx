'use client';

import { cn } from '@/lib/utils';
import { CATEGORIES, type Category, type DataStatus } from '@/lib/types';
import {
  Zap,
  Flame,
  Droplets,
  Trash2,
  Truck,
  Plane,
  Snowflake,
  Package,
  Car,
  Users,
  Factory,
} from 'lucide-react';

interface CategoryNavProps {
  selectedCategory: Category;
  onCategoryChange: (category: Category) => void;
  categoryStatuses: Record<Category, DataStatus>;
}

const categoryIcons: Record<Category, typeof Zap> = {
  'Electricity': Zap,
  'Natural Gas': Flame,
  'Fuel': Flame,
  'Mobile Combustion': Car,
  'Refrigerants': Snowflake,
  'Purchased Goods': Package,
  'Waste': Trash2,
  'Water': Droplets,
  'Business Travel': Plane,
  'Commuting': Users,
  'Logistics': Truck,
};

const statusColors: Record<DataStatus, string> = {
  complete: 'bg-emerald-500',
  incomplete: 'bg-amber-500',
  missing: 'bg-red-500',
};

export function CategoryNav({ selectedCategory, onCategoryChange, categoryStatuses }: CategoryNavProps) {
  return (
    <nav className="w-56 shrink-0 border-r border-border bg-card/30 overflow-y-auto">
      <div className="p-4">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
          Data Categories
        </h3>
        <ul className="space-y-1">
          {CATEGORIES.map((category) => {
            const Icon = categoryIcons[category] || Factory;
            const status = categoryStatuses[category];
            const isSelected = selectedCategory === category;

            return (
              <li key={category}>
                <button
                  onClick={() => onCategoryChange(category)}
                  className={cn(
                    'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all',
                    isSelected
                      ? 'bg-primary/10 text-primary border border-primary/20'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  )}
                >
                  <Icon className={cn('h-4 w-4 shrink-0', isSelected && 'text-primary')} />
                  <span className="truncate flex-1 text-left">{category}</span>
                  <span
                    className={cn(
                      'h-2 w-2 rounded-full shrink-0',
                      statusColors[status]
                    )}
                  />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
