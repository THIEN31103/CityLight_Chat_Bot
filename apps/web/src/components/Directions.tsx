// "Chỉ đường" to a cabinet / incident in Google Maps (opens the app on phones, for field technicians).
import { Navigation } from 'lucide-react';
import type { GeoPoint } from '@citylight/shared';
import { directionsUrl } from '@citylight/shared';
import { cn } from '@/lib/utils';
import { useDict } from '@/i18n';
import { DIRECTIONS } from '@/i18n/dict/directions';

/** Outline button (`full` = text) or a header icon; renders nothing when the point is unset. */
export function DirectionsLink({ point, icon, className }: { point: GeoPoint | null | undefined; icon?: boolean; className?: string }) {
  const t = useDict(DIRECTIONS);
  const href = directionsUrl(point);
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={t.title}
      aria-label={t.title}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        icon ? 'p-1.5 text-fg hover:bg-muted' : 'h-8 border bg-panel px-2.5 text-xs text-fg hover:bg-muted',
        className,
      )}
    >
      <Navigation className={icon ? 'h-5 w-5' : 'h-4 w-4'} />
      {!icon && t.short}
    </a>
  );
}
