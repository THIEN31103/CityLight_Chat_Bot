import { Link } from 'react-router-dom';
import { ShieldX, MapPinOff } from 'lucide-react';
import { useDict } from '@/i18n';
import { ERROR_PAGES } from '@/i18n/dict/system';
import { Button } from '@/components/ui';

export function ForbiddenPage() {
  const t = useDict(ERROR_PAGES);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <ShieldX className="h-12 w-12 text-st-offline" />
      <h1 className="text-xl font-semibold">{t.forbiddenTitle}</h1>
      <p className="max-w-md text-sm text-subtle">{t.forbiddenBody}</p>
      <Link to="/">
        <Button variant="outline">{t.home}</Button>
      </Link>
    </div>
  );
}

export function NotFoundPage() {
  const t = useDict(ERROR_PAGES);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <MapPinOff className="h-12 w-12 text-subtle" />
      <h1 className="text-xl font-semibold">{t.notFoundTitle}</h1>
      <Link to="/">
        <Button variant="outline">{t.home}</Button>
      </Link>
    </div>
  );
}
