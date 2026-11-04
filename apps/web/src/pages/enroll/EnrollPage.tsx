import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, QrCode } from 'lucide-react';
import { parseCabinetCode, type GeoPoint } from '@citylight/shared';
import { api, ApiError } from '@/lib/api';
import { dictNow, fill, useDict } from '@/i18n';
import { COMMON } from '@/i18n/dict/common';
import { ENROLL } from '@/i18n/dict/enroll';
import { fmtTime } from '@/lib/utils';
import { Button, Card, Field, Input, KV, PageHeader, Spinner, toast } from '@/components/ui';
import { QrScanner } from './QrScanner';

const WAITING_RECHECK_MS = 5000;
const PHONE_FIX_TIMEOUT_MS = 8000;

/** The phone's position, or null when it is refused, unavailable or too slow. */
function phonePosition(): Promise<GeoPoint | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: PHONE_FIX_TIMEOUT_MS },
    );
  });
}

function Notice({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <Card className="space-y-1 p-4">
      <div className="font-semibold">{title}</div>
      {children && <div className="text-sm text-subtle">{children}</div>}
    </Card>
  );
}

export function EnrollPage() {
  const t = useDict(ENROLL);
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [done, setDone] = useState<string | null>(null);

  const lookup = useQuery({
    queryKey: ['enroll-lookup', code],
    queryFn: () => api.lookupCabinetCode(code!),
    enabled: !!code,
    refetchInterval: (q) => (q.state.data?.status === 'waiting' ? WAITING_RECHECK_MS : false),
  });

  const reset = () => {
    setCode(null);
    setText('');
    setName('');
    setAddress('');
    setError(null);
    setDone(null);
  };

  const accept = (raw: string) => {
    const parsed = parseCabinetCode(raw);
    setScanning(false);
    setDone(null);
    setError(parsed ? null : fill(t.badCode, { text: raw.trim().slice(0, 40) }));
    setCode(parsed);
    if (parsed) setText(parsed);
  };

  const enroll = useMutation({
    mutationFn: async () => {
      const location = lookup.data?.device?.gps ? null : await phonePosition();
      return api.enrollCabinet({ code: code!, name: name.trim() || null, address: address.trim() || null, location });
    },
    onSuccess: () => {
      setDone(code);
      setCode(null);
      void qc.invalidateQueries({ queryKey: ['unknown-devices'] });
      void qc.invalidateQueries({ queryKey: ['registration-history'] });
      void qc.invalidateQueries({ queryKey: ['map-cabinets'] });
    },
    onError: (e) => {
      toast(e instanceof ApiError ? e.message : dictNow(COMMON).error, 'error');
      void lookup.refetch();
    },
  });

  const found = code ? lookup.data : undefined;

  return (
    <div className="mx-auto w-full max-w-md space-y-4 p-4">
      <PageHeader title={t.title} subtitle={t.subtitle} />

      {done ? (
        <Card className="space-y-3 p-4 text-center">
          <CheckCircle2 className="mx-auto h-10 w-10 text-st-on" />
          <div className="font-semibold">{fill(t.doneTitle, { code: done })}</div>
          <Button className="w-full" onClick={reset}>{t.scanAnother}</Button>
        </Card>
      ) : (
        <>
          {!code && (
            <Card className="space-y-3 p-4">
              {scanning ? (
                <>
                  <QrScanner
                    onRead={accept}
                    onCameraError={(message) => {
                      setScanning(false);
                      setError(message);
                    }}
                  />
                  <Button variant="outline" className="w-full" onClick={() => setScanning(false)}>{t.stopScan}</Button>
                </>
              ) : (
                <Button
                  className="w-full"
                  onClick={() => {
                    setError(null);
                    setScanning(true);
                  }}
                >
                  <QrCode className="h-4 w-4" /> {t.scan}
                </Button>
              )}
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  accept(text);
                }}
              >
                <Field label={t.codeLabel}>
                  <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={t.codePlaceholder} autoCapitalize="characters" autoCorrect="off" spellCheck={false} />
                </Field>
                <Button type="submit" variant="outline" className="w-full" disabled={!text.trim()}>{t.lookUp}</Button>
              </form>
              {error && <div className="text-sm text-st-offline">{error}</div>}
            </Card>
          )}

          {code && lookup.isPending && (
            <Card className="flex items-center gap-2 p-4 text-sm text-subtle"><Spinner /> {t.checking}</Card>
          )}

          {code && lookup.isError && <Notice title={lookup.error instanceof ApiError ? lookup.error.message : dictNow(COMMON).error} />}

          {found?.status === 'waiting' && <Notice title={fill(t.waitingTitle, { code: found.code })}>{t.waitingBody}</Notice>}
          {found?.status === 'registered' && (
            <Notice title={fill(t.registeredTitle, { code: found.code })}>{found.cabinet && fill(t.registeredName, { name: found.cabinet.name })}</Notice>
          )}
          {found?.status === 'conflict' && <Notice title={fill(t.conflictTitle, { code: found.code })}>{t.conflictBody}</Notice>}

          {found?.status === 'ready' && found.device && (
            <Card className="space-y-3 p-4">
              <div className="font-semibold text-st-on">{t.ready}</div>
              <KV label={t.codeLabel} value={found.code} />
              <KV label={t.lastSeen} value={fmtTime(found.device.lastSeenAt)} />
              <KV label={t.gps} value={found.device.gps ? `${found.device.gps.lat.toFixed(5)}, ${found.device.gps.lng.toFixed(5)}` : t.noGps} />
              {found.device.imeiTail && <KV label={t.imei} value={found.device.imeiTail} />}
              <Field label={t.name}><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
              <Field label={t.address}><Input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={300} /></Field>
              <Button className="w-full" loading={enroll.isPending} onClick={() => enroll.mutate()}>{t.confirm}</Button>
            </Card>
          )}

          {code && <Button variant="outline" className="w-full" onClick={reset}>{t.scanAnother}</Button>}
        </>
      )}
    </div>
  );
}
