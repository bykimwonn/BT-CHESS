import { PaynowAdapter } from './adapters/paynow.js';
import { EcoCashAdapter } from './adapters/ecocash.js';
import { PesePayAdapter } from './adapters/pesepay.js';
import { OneMoneyAdapter } from './adapters/onemoney.js';
import type { FetchLike } from './http.js';
import type { PaymentAdapter, ProviderId } from './types.js';

export function createAdapters(fetchFn: FetchLike = fetch): Record<ProviderId, PaymentAdapter> {
  return {
    paynow: new PaynowAdapter(fetchFn),
    ecocash: new EcoCashAdapter(fetchFn),
    pesepay: new PesePayAdapter(fetchFn),
    onemoney: new OneMoneyAdapter(),
  };
}
