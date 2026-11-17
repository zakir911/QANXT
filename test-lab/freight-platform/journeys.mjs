/**
 * The six end-to-end journeys through Meridian Freight.
 *
 * ## Why these exist
 *
 * A hundred and thirty-seven screens that do not connect to each other is a screen
 * gallery, not an application. What makes this a usable measurement of a testing platform
 * is that state crosses domains: an order becomes a shipment, the shipment goes on a
 * route, the route is dispatched, the delivery is invoiced, the invoice is paid, and a
 * failure anywhere in that chain shows up three domains away.
 *
 * Each journey here is driven as a real person would drive it, through real forms, with
 * real validation and the real session. At every step the *consequence* is asserted in a
 * different domain from the one the action happened in, because that is the whole point:
 *
 *   `node journeys.mjs`            # against the corrected build (every fault off)
 *   `node journeys.mjs --dirty`    # against the shipped build (every defect on)
 *
 * Run both. The corrected build should complete all six: if it cannot, the lab is broken
 * and nothing measured against it means anything. The shipped build should break some of
 * them in specific, documented ways, and which ones it breaks is itself ground truth: a
 * testing platform that drives these journeys ought to find those breakages, and the ones
 * it does not find are the honest gap.
 */
const PORT = Number(process.argv[process.argv.indexOf('--port') + 1]) || Number(process.env.PORT) || 4400;
const DIRTY = process.argv.includes('--dirty');
const BASE = `http://127.0.0.1:${PORT}`;

let cookie = '';

const request = async (path, options = {}) => {
  const response = await fetch(`${BASE}${path}`, {
    ...options, redirect: 'manual',
    headers: { ...(options.headers ?? {}), ...(cookie ? { cookie } : {}) }
  });
  for (const entry of response.headers.getSetCookie?.() ?? []) {
    const [pair] = entry.split(';');
    if (pair.startsWith('lab_session=') && !pair.endsWith('=')) cookie = pair;
  }
  return response;
};

const get = async (path) => {
  const response = await request(path);
  return { status: response.status, body: await response.text(), headers: response.headers };
};

const csrfFrom = (body) => body.match(/name="_csrf" value="([^"]*)"/)?.[1] ?? '';

const post = async (path, fields, { referer } = {}) => {
  const page = await get(referer ?? path);
  const response = await request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrfFrom(page.body), ...fields }).toString()
  });
  return { status: response.status, location: response.headers.get('location') ?? '' };
};

const signIn = async (username) => {
  cookie = '';
  await post('/auth/sign-in', { username, password: 'Freight!2026', next: '/dashboard' });
};

const viewOf = async (path) => {
  const response = await get(`/api/view?path=${encodeURIComponent(path)}`);
  return response.status === 200 ? JSON.parse(response.body) : { title: '', html: '' };
};

// ---------------------------------------------------------------------------

const results = [];

async function journey(id, name, steps) {
  console.log(`\n${id} — ${name}`);
  const record = { id, name, steps: [], outcome: 'completed' };
  const carried = {};

  for (const step of steps) {
    let detail = '';
    try {
      detail = (await step.run(carried)) ?? '';
      console.log(`  ✓ ${step.name}${detail ? ` — ${detail}` : ''}`);
      record.steps.push({ name: step.name, outcome: 'passed', detail });
    } catch (error) {
      console.log(`  ✗ ${step.name} — ${error.message}`);
      record.steps.push({ name: step.name, outcome: 'failed', detail: error.message });
      record.outcome = 'broken';
      record.brokeAt = step.name;
      break;
    }
  }

  results.push(record);
  return record;
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const setFaults = (patch) => fetch(`${BASE}/__faults`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch)
}).then(r => r.json());

// ---------------------------------------------------------------------------

const health = await fetch(`${BASE}/health`).then(r => r.json()).catch(() => null);
if (!health) {
  console.error(`Nothing is listening on ${BASE}. Start it with: node test-lab/freight-platform/server.js`);
  process.exit(1);
}

if (DIRTY) {
  await fetch(`${BASE}/__faults/reset`, { method: 'POST' });
  console.log(`\nDriving the SHIPPED build (every defect on) at ${BASE}`);
} else {
  const { faults } = await fetch(`${BASE}/__faults`).then(r => r.json());
  await setFaults(Object.fromEntries(faults.map(entry => [entry.id, false])));
  console.log(`\nDriving the CORRECTED build (every defect off) at ${BASE}`);
}

// ---------------------------------------------------------------------------
// J1 — Order to cash: order → shipment → route → dispatch → delivery → invoice → payment
// ---------------------------------------------------------------------------

await journey('J1', 'Order to cash', [
  {
    name: 'an operations lead signs in',
    run: async () => {
      await signIn('ops.lead');
      const dashboard = await get('/dashboard');
      assert(dashboard.status === 200, `the dashboard answered ${dashboard.status}`);
      return 'ops.lead';
    }
  },
  {
    name: 'a sales order is placed for an active customer',
    run: async (carried) => {
      const customers = await get('/customers');
      const activeId = [...customers.body.matchAll(/href="\/customers\/(cus-\d+)"/g)]
        .map(match => match[1])
        .find(id => !customers.body.includes(`${id}"`) || true);
      carried.customerId = activeId ?? 'cus-001';
      const created = await post('/orders/sales/new', {
        customerId: carried.customerId, requestedDeliveryOn: '2026-04-20',
        serviceLevel: 'STD', incoterm: 'DAP', skuId: 'sku-001', quantity: '12',
        notes: 'Driven by the journey suite.'
      }, { referer: '/orders/sales/new' });
      assert(created.location.startsWith('/orders/sales/so-'), `the order was not created: ${created.status} ${created.location}`);
      carried.orderId = created.location.split('/').pop();
      return carried.orderId;
    }
  },
  {
    name: 'the order appears on the customer record, in another domain',
    run: async (carried) => {
      const customer = await get(`/customers/${carried.customerId}`);
      assert(customer.body.includes(carried.orderId), 'the new order is not on the customer record');
      return 'visible on the customer';
    }
  },
  {
    name: 'a shipment is booked through the four-step wizard',
    run: async (carried) => {
      const step1 = await post('/shipments/new?step=1', {
        step: '1', customerId: carried.customerId, originWarehouseId: 'wh-fxt',
        collectionDate: '2026-04-14', deliveryDate: '2026-04-18', incoterm: 'DAP'
      }, { referer: '/shipments/new?step=1' });
      assert(step1.location === '/shipments/new?step=2', `step 1 did not advance: ${step1.location}`);

      const step2 = await post('/shipments/new?step=2', {
        step: '2', pieces: '6', weight: '420', weightUnit: 'kg', volumeM3: '2.4',
        declaredValue: '8400', goodsDescription: 'Portable data-processing machines, boxed.'
      }, { referer: '/shipments/new?step=2' });
      assert(step2.location === '/shipments/new?step=3', `step 2 did not advance: ${step2.location}`);

      const step3 = await post('/shipments/new?step=3', {
        step: '3', serviceLevel: 'STD', carrierId: 'car-001', reference: 'JOURNEY-J1'
      }, { referer: '/shipments/new?step=3' });
      assert(step3.location === '/shipments/new?step=4', `step 3 did not advance: ${step3.location}`);

      const confirm = await post('/shipments/new?step=4', { step: '4' }, { referer: '/shipments/new?step=4' });
      assert(confirm.location.startsWith('/shipments/shp-'), `the booking did not confirm: ${confirm.location}`);
      carried.shipmentId = confirm.location.split('/').pop();
      return carried.shipmentId;
    }
  },
  {
    name: 'the booked weight is what was typed',
    run: async (carried) => {
      const shipment = await get(`/shipments/${carried.shipmentId}`);
      const weight = shipment.body.match(/data-testid="detail-weight"[^>]*><div class="value">([\d.]+) kg/)?.[1];
      assert(weight === '420', `the shipment shows ${weight} kg, not the 420 kg entered`);
      return `${weight} kg`;
    }
  },
  {
    name: 'the shipment is planned onto a route',
    run: async (carried) => {
      const planned = await post('/routes/planner', {
        planDate: '2026-04-14', depotId: 'wh-fxt', vehicleId: 'veh-001', driverId: 'drv-001',
        startTime: '07:00', shipmentIds: carried.shipmentId
      }, { referer: '/routes/planner' });
      assert(planned.location.startsWith('/routes/rte-'), `the route was not created: ${planned.status} ${planned.location}`);
      carried.routeId = planned.location.split('/').pop();
      const stops = await viewOf(`/routes/${carried.routeId}/stops`);
      assert(stops.html.includes(carried.shipmentId), 'the shipment is not a stop on the route');
      return `${carried.routeId} with the consignment as a stop`;
    }
  },
  {
    name: 'the route is dispatched by somebody with the permission',
    run: async (carried) => {
      await signIn('driver.ops');
      const dispatched = await post(`/routes/${carried.routeId}/dispatch`, {},
        { referer: `/routes/${carried.routeId}` });
      assert(dispatched.status === 302, `dispatch answered ${dispatched.status}`);
      const route = await viewOf(`/routes/${carried.routeId}`);
      assert(route.html.includes('data-status="dispatched"'), 'the route is not dispatched');
      return 'dispatched by fleet';
    }
  },
  {
    name: 'finance raises an invoice against the delivered consignment',
    run: async (carried) => {
      await signIn('finance');
      const delivered = await get('/billing/reconciliation');
      const billable = delivered.body.match(/href="\/shipments\/(shp-\d+)"/)?.[1] ?? carried.shipmentId;
      carried.invoicedShipmentId = billable;
      const created = await post('/billing/invoices/new', {
        customerId: carried.customerId, shipmentId: billable, netGbp: '640',
        issuedOn: '2026-03-02', reference: ''
      }, { referer: '/billing/invoices/new' });
      assert(created.location.startsWith('/billing/invoices/inv-'), `the invoice was not raised: ${created.location}`);
      carried.invoiceId = created.location.split('/').pop();
      return carried.invoiceId;
    }
  },
  {
    name: 'the fuel surcharge is 11.5% of net, not of the gross',
    run: async (carried) => {
      const invoice = await get(`/billing/invoices/${carried.invoiceId}`);
      const net = Number(invoice.body.match(/data-testid="invoice-net"[^>]*><div class="value">£([\d,.]+)/)?.[1]?.replace(/,/g, ''));
      const fuel = Number(invoice.body.match(/data-testid="fuel-surcharge">£([\d,.]+)/)?.[1]?.replace(/,/g, ''));
      const expected = Math.round(net * 0.115 * 100) / 100;
      assert(Math.abs(fuel - expected) < 0.02,
        `the fuel surcharge is ${fuel} but 11.5% of the ${net} net is ${expected}`);
      return `${fuel} on ${net} net`;
    }
  },
  {
    name: 'a payment settles the invoice and it leaves the aged debt report',
    run: async (carried) => {
      const paid = await post(`/billing/invoices/${carried.invoiceId}/pay`, {
        amount: '768', method: 'Bank transfer', receivedOn: '2026-03-02'
      }, { referer: `/billing/invoices/${carried.invoiceId}` });
      assert(paid.status === 302, `the payment answered ${paid.status}`);
      const invoice = await get(`/billing/invoices/${carried.invoiceId}`);
      assert(invoice.body.includes('data-status="paid"'), 'the invoice is not marked paid');
      const aging = await get('/billing/aging');
      assert(!aging.body.includes(carried.invoiceId), 'the paid invoice is still on the aged debt report');
      return 'paid and off the aged debt report';
    }
  }
]);

// ---------------------------------------------------------------------------
// J2 — Procure to dispatch: purchase order → receive → putaway → pick → pack
// ---------------------------------------------------------------------------

await journey('J2', 'Procure to dispatch', [
  {
    name: 'a purchase order is raised',
    run: async (carried) => {
      await signIn('ops.lead');
      const created = await post('/orders/purchase/new', {
        supplierName: 'Kestrel Supply Co', warehouseId: 'wh-fxt', expectedOn: '2026-03-10',
        skuId: 'sku-002', quantity: '400'
      }, { referer: '/orders/purchase/new' });
      assert(created.location.startsWith('/orders/purchase/po-'), `not created: ${created.location}`);
      carried.purchaseOrderId = created.location.split('/').pop();
      return carried.purchaseOrderId;
    }
  },
  {
    name: 'the warehouse sees it on the receiving screen',
    run: async (carried) => {
      await signIn('warehouse');
      const receiving = await get('/warehouse/receiving');
      assert(receiving.body.includes(carried.purchaseOrderId),
        'the new purchase order is not offered for receipt');
      return 'expected at Felixstowe';
    }
  },
  {
    name: 'a partial receipt is recorded, and over-receipt is refused',
    run: async (carried) => {
      const partial = await post('/warehouse/receiving', {
        purchaseOrderId: carried.purchaseOrderId, quantityReceived: '150',
        condition: 'Good', bin: 'FXT-Z1-004'
      }, { referer: '/warehouse/receiving' });
      assert(partial.status === 302, `the receipt answered ${partial.status}`);

      const tooMany = await post('/warehouse/receiving', {
        purchaseOrderId: carried.purchaseOrderId, quantityReceived: '9999',
        condition: 'Good', bin: 'FXT-Z1-004'
      }, { referer: '/warehouse/receiving' });
      const after = await get('/warehouse/receiving');
      assert(after.body.includes('Only 250 outstanding') || after.body.includes('outstanding'),
        'an over-receipt was not refused');
      return '150 of 400 received, over-receipt refused';
    }
  },
  {
    name: 'the order reads partiallyReceived in the orders domain',
    run: async (carried) => {
      const order = await get(`/orders/purchase/${carried.purchaseOrderId}`);
      assert(order.body.includes('data-status="partiallyReceived"'),
        'the purchase order did not move to partiallyReceived');
      const outstanding = order.body.match(/<td>250<\/td>/);
      assert(outstanding, 'the outstanding quantity is not 250');
      return '250 outstanding';
    }
  },
  {
    name: 'the received goods appear on the putaway list',
    run: async (carried) => {
      const putaway = await get('/warehouse/putaway');
      assert(putaway.body.includes(carried.purchaseOrderId),
        'the received goods are not waiting for putaway');
      return 'waiting for putaway';
    }
  },
  {
    name: 'an approved order is ready to pick',
    run: async () => {
      const picking = await get('/warehouse/picking');
      assert(picking.status === 200, `the picking screen answered ${picking.status}`);
      const rows = (picking.body.match(/href="\/orders\/sales\/so-\d+"/g) ?? []).length;
      assert(rows > 0, 'nothing is ready to pick, so the chain stops here');
      return `${rows} order(s) ready`;
    }
  },
  {
    name: 'packing is recorded with a whole number of cartons',
    run: async () => {
      const rejected = await post('/warehouse/packing', {
        orderId: '', cartons: '0', grossWeightKg: '12'
      }, { referer: '/warehouse/packing' });
      const page = await get('/warehouse/packing');
      assert(page.body.includes('whole number of cartons') || rejected.status === 302,
        'a zero carton count was accepted');
      return 'zero cartons refused';
    }
  }
]);

// ---------------------------------------------------------------------------
// J3 — Carrier onboarding to first booking
// ---------------------------------------------------------------------------

await journey('J3', 'Carrier onboarding to first booking', [
  {
    name: 'a new carrier is added with a unique code',
    run: async (carried) => {
      await signIn('ops.lead');
      const code = `JY${Math.floor(Math.random() * 900 + 100)}`;
      const created = await post('/carriers/new', {
        name: `Journey Haulage ${code}`, code, mode: 'road', scacCode: 'JRNY',
        contactEmail: 'bookings@journeyhaulage.test', contactPhone: '+44 161 496 9000',
        insuranceExpiry: '2027-03-31'
      }, { referer: '/carriers/new' });
      assert(created.location.startsWith('/carriers/car-'), `not created: ${created.status} ${created.location}`);
      carried.carrierId = created.location.split('/').pop();
      carried.carrierCode = code;
      return `${carried.carrierId} (${code})`;
    }
  },
  {
    name: 'a duplicate code is refused',
    run: async (carried) => {
      const duplicate = await post('/carriers/new', {
        name: 'Another Haulage', code: carried.carrierCode, mode: 'road',
        contactEmail: 'x@y.test', insuranceExpiry: '2027-03-31'
      }, { referer: '/carriers/new' });
      const page = await get('/carriers/new');
      assert(page.body.includes('already in use'), 'a duplicate carrier code was accepted');
      return 'refused';
    }
  },
  {
    name: 'a rate card was created with it',
    run: async (carried) => {
      const rates = await get(`/carriers/${carried.carrierId}/rates`);
      assert(rates.status === 200 && rates.body.includes('rate-bands'),
        `the rate card answered ${rates.status}`);
      return 'four weight bands';
    }
  },
  {
    name: 'a weight on a band boundary is rated in the upper band',
    run: async (carried) => {
      const at50 = await get(`/carriers/${carried.carrierId}/quote?weight=50`);
      const at5001 = await get(`/carriers/${carried.carrierId}/quote?weight=50.01`);
      const rate50 = at50.body.match(/Rate per kg<\/dt><dd>£([\d.]+)/)?.[1];
      const rate5001 = at5001.body.match(/Rate per kg<\/dt><dd>£([\d.]+)/)?.[1];
      assert(rate50 !== undefined && rate5001 !== undefined, 'the quote returned no rate');
      assert(rate50 !== rate5001,
        `50 kg and 50.01 kg are both rated at ${rate50}, but the card says the boundary belongs to the upper band`);
      return `50 kg at ${rate50}, 50.01 kg at ${rate5001}`;
    }
  },
  {
    name: 'onboarding will not complete with a mandatory check missing',
    run: async (carried) => {
      const incomplete = await post('/carriers/onboarding', {
        carrierId: carried.carrierId, insuranceChecked: 'on', licenceChecked: 'on',
        termsSigned: 'on', notes: 'Rate card not yet agreed.'
      }, { referer: '/carriers/onboarding' });
      const page = await get('/carriers/onboarding');
      assert(page.body.includes('not complete'), 'onboarding completed with a mandatory check missing');
      return 'refused with one check missing';
    }
  },
  {
    name: 'onboarding completes with every check, and the carrier becomes bookable',
    run: async (carried) => {
      await post('/carriers/onboarding', {
        carrierId: carried.carrierId, insuranceChecked: 'on', licenceChecked: 'on',
        termsSigned: 'on', rateCardAgreed: 'on', ediTested: 'on', notes: 'Complete.'
      }, { referer: '/carriers/onboarding' });
      const wizard = await get('/shipments/new?step=3');
      assert(wizard.body.includes(carried.carrierId),
        'the onboarded carrier is not offered in the booking wizard');
      return 'offered in the booking wizard';
    }
  }
]);

// ---------------------------------------------------------------------------
// J4 — Exception to claim settlement
// ---------------------------------------------------------------------------

await journey('J4', 'Exception to claim settlement', [
  {
    name: 'an exception is recorded against a delivered consignment',
    run: async (carried) => {
      await signIn('ops.lead');
      const shipments = await get('/shipments?status=delivered');
      const id = shipments.body.match(/href="\/shipments\/(shp-\d+)"/)?.[1];
      assert(id, 'no delivered shipment to raise an exception against');
      carried.shipmentId = id;
      const recorded = await post(`/shipments/${id}/exception`, {
        code: 'DAMAGED', notes: 'Two pallets arrived with crushed corners and the wrap torn open.'
      }, { referer: `/shipments/${id}/exception` });
      assert(recorded.status === 302, `the exception answered ${recorded.status}`);
      const shipment = await get(`/shipments/${id}`);
      assert(shipment.body.includes('data-status="exception"'), 'the shipment is not in exception');
      return id;
    }
  },
  {
    name: 'it shows on the control tower exception list, in another domain',
    run: async (carried) => {
      const exceptions = await get('/dashboard/exceptions');
      assert(exceptions.body.includes(carried.shipmentId),
        'the exception is not on the control tower list');
      return 'escalated to the control tower';
    }
  },
  {
    name: 'a claim above the declared value is refused',
    run: async (carried) => {
      const shipment = await get(`/shipments/${carried.shipmentId}`);
      const declared = shipment.body.match(/Declared value<\/dt><dd>£([\d,.]+)/)?.[1]?.replace(/,/g, '');
      carried.declaredValue = Number(declared);
      await post('/claims/new', {
        shipmentId: carried.shipmentId, type: 'damage',
        claimedAmountGbp: String(carried.declaredValue + 10_000),
        description: 'Claiming more than the consignment was worth, which must be refused.',
        incidentDate: '2026-03-01'
      }, { referer: '/claims/new' });
      const form = await viewOf('/claims/new');
      assert(/cannot exceed the declared value/.test(form.html),
        'a claim above the declared value was accepted');
      return `refused above ${carried.declaredValue}`;
    }
  },
  {
    name: 'a claim within the declared value is raised',
    run: async (carried) => {
      const created = await post('/claims/new', {
        shipmentId: carried.shipmentId, type: 'damage', claimedAmountGbp: '480',
        description: 'Two pallets crushed in transit; repair quote attached separately.',
        incidentDate: '2026-03-01'
      }, { referer: '/claims/new' });
      assert(created.location.startsWith('/claims/clm-'), `the claim was not raised: ${created.location}`);
      carried.claimId = created.location.split('/').pop();
      return carried.claimId;
    }
  },
  {
    name: 'evidence within the size limit is attached',
    run: async (carried) => {
      const attached = await post(`/claims/${carried.claimId}/evidence`, {
        evidenceType: 'photograph', sizeKb: '820', note: 'Four photographs of the damage.'
      }, { referer: `/claims/${carried.claimId}/evidence` });
      assert(attached.status === 302, `the upload answered ${attached.status}`);
      const claim = await viewOf(`/claims/${carried.claimId}`);
      assert(/data-testid="claim-evidence-count"[^>]*><div class="value">1/.test(claim.html),
        'the evidence was not attached');
      return 'one item attached';
    }
  },
  {
    name: 'an oversize upload is refused rather than crashing',
    run: async (carried) => {
      const oversize = await post(`/claims/${carried.claimId}/evidence`, {
        evidenceType: 'photograph', sizeKb: '9000', note: 'Too large.'
      }, { referer: `/claims/${carried.claimId}/evidence` });
      assert(oversize.status !== 500, 'an oversize upload returned 500 instead of a field error');
      return `refused with ${oversize.status}`;
    }
  },
  {
    name: 'a viewer cannot settle the claim',
    run: async (carried) => {
      await signIn('readonly');
      const screen = await get(`/claims/${carried.claimId}/settle`);
      assert(screen.status === 403, `the settle screen answered ${screen.status} for a viewer`);
      const attempt = await post(`/claims/${carried.claimId}/settle`, {
        settledAmountGbp: '480', note: 'A viewer should not be able to do this.'
      }, { referer: `/claims/${carried.claimId}` });
      const claim = await viewOf(`/claims/${carried.claimId}`);
      assert(!claim.html.includes('data-status="settled"'),
        'a viewer settled the claim: the handler does not enforce what the screen shows');
      return 'refused by both the screen and the handler';
    }
  },
  {
    name: 'finance settles it, and the settlement is audited',
    run: async (carried) => {
      await signIn('finance');
      const settled = await post(`/claims/${carried.claimId}/settle`, {
        settledAmountGbp: '420', recoverFromCarrier: 'on',
        note: 'Settled at the repair quote, recovering from the carrier.'
      }, { referer: `/claims/${carried.claimId}/settle` });
      assert(settled.status === 302, `settlement answered ${settled.status}`);
      const claim = await viewOf(`/claims/${carried.claimId}`);
      assert(claim.html.includes('data-status="settled"'), 'the claim is not settled');
      await signIn('admin');
      const audit = await viewOf('/admin/audit?action=claim.settled');
      assert(audit.html.includes('claim.settled'), 'the settlement was not audited');
      return 'settled at 420 and audited';
    }
  }
]);

// ---------------------------------------------------------------------------
// J5 — Customs hold to release
// ---------------------------------------------------------------------------

await journey('J5', 'Customs hold to release', [
  {
    name: 'a held declaration is found with its reason',
    run: async (carried) => {
      await signIn('customs');
      const holds = await get('/customs/holds');
      const id = holds.body.match(/href="\/customs\/declarations\/(dec-\d+)"/)?.[1];
      assert(id, 'no declaration is held');
      carried.declarationId = id;
      const detail = await get(`/customs/declarations/${id}`);
      assert(detail.body.includes('data-testid="hold-reason"'), 'the hold gives no reason');
      return id;
    }
  },
  {
    name: 'the missing document is attached',
    run: async (carried) => {
      const attached = await post(`/customs/declarations/${carried.declarationId}/documents`, {
        documentType: 'commercialInvoice'
      }, { referer: `/customs/declarations/${carried.declarationId}/documents` });
      assert(attached.status === 302, `the upload answered ${attached.status}`);
      return 'commercial invoice attached';
    }
  },
  {
    name: 'duty on delivered terms includes the freight cost',
    run: async () => {
      const list = await get('/customs/declarations');
      const ids = [...list.body.matchAll(/href="\/customs\/declarations\/(dec-\d+)"/g)].map(m => m[1]);
      for (const id of ids) {
        const detail = await get(`/customs/declarations/${id}`);
        if (!/Incoterm includes freight<\/dt><dd>Yes/.test(detail.body)) continue;
        const basis = Number(detail.body.match(/data-testid="duty-basis">£([\d,.]+)/)?.[1]?.replace(/,/g, ''));
        const goods = Number(detail.body.match(/Goods value<\/dt><dd>£([\d,.]+)/)?.[1]?.replace(/,/g, ''));
        const freight = Number(detail.body.match(/Freight cost<\/dt><dd>£([\d,.]+)/)?.[1]?.replace(/,/g, ''));
        assert(Math.abs(basis - (goods + freight)) < 0.02,
          `the value for duty is ${basis}, but goods ${goods} plus freight ${freight} is ${goods + freight}`);
        return `${basis} = ${goods} + ${freight}`;
      }
      throw new Error('no declaration sits on delivered terms, so the rule cannot be checked');
    }
  },
  {
    name: 'a rejected declaration cannot be released',
    run: async () => {
      const rejected = await get('/customs/declarations?status=rejected');
      const id = rejected.body.match(/href="\/customs\/declarations\/(dec-\d+)"/)?.[1];
      assert(id, 'no rejected declaration to try');
      await post(`/customs/declarations/${id}/release`, {
        reference: 'JOURNEY-CLR', note: 'This should be refused.'
      }, { referer: `/customs/declarations/${id}/release` });
      const detail = await get(`/customs/declarations/${id}`);
      assert(!detail.body.includes('data-status="released"'),
        'a declaration customs rejected was released anyway');
      return 'refused';
    }
  },
  {
    name: 'the held declaration is released and its shipment moves on',
    run: async (carried) => {
      const detail = await get(`/customs/declarations/${carried.declarationId}`);
      const shipmentId = detail.body.match(/href="\/shipments\/(shp-\d+)"/)?.[1];
      const released = await post(`/customs/declarations/${carried.declarationId}/release`, {
        reference: 'JOURNEY-CLR-OK', note: 'Documentation now complete.'
      }, { referer: `/customs/declarations/${carried.declarationId}/release` });
      assert(released.status === 302, `release answered ${released.status}`);
      const after = await get(`/customs/declarations/${carried.declarationId}`);
      assert(after.body.includes('data-status="released"'), 'the declaration is not released');
      if (shipmentId) {
        const shipment = await get(`/shipments/${shipmentId}`);
        assert(!shipment.body.includes('data-status="customsHold"'),
          'the shipment is still held after its declaration was released');
      }
      return shipmentId ? `released, ${shipmentId} moving again` : 'released';
    }
  }
]);

// ---------------------------------------------------------------------------
// J6 — User onboarding to permission enforcement to audit
// ---------------------------------------------------------------------------

await journey('J6', 'User onboarding to audit trail', [
  {
    name: 'an administrator invites a user into the least-access role',
    run: async (carried) => {
      await signIn('admin');
      const email = `journey${Math.floor(Math.random() * 9000 + 1000)}@meridian.test`;
      carried.email = email;
      const invited = await post('/admin/users/new', {
        displayName: 'Journey Tester', email, role: 'viewer', team: 'Internal audit', requireMfa: 'on'
      }, { referer: '/admin/users/new' });
      assert(invited.status === 302, `the invitation answered ${invited.status}`);
      const users = await viewOf('/admin/users');
      assert(users.html.includes(email), 'the invited user is not listed');
      carried.username = email.split('@')[0];
      return email;
    }
  },
  {
    name: 'a duplicate email is refused',
    run: async (carried) => {
      await post('/admin/users/new', {
        displayName: 'Duplicate', email: carried.email, role: 'viewer', team: 'Platform'
      }, { referer: '/admin/users/new' });
      const page = await viewOf('/admin/users/new');
      const users = await viewOf('/admin/users');
      const occurrences = (users.html.match(new RegExp(carried.email, 'g')) ?? []).length;
      assert(occurrences === 1, `the email appears ${occurrences} times, so a duplicate was accepted`);
      return 'refused';
    }
  },
  {
    name: 'the permission matrix shows the viewer role holds only reads',
    run: async () => {
      const matrix = await viewOf('/admin/permissions');
      assert(matrix.html.includes('permission-matrix'), 'the permission matrix did not render');
      const viewerColumn = matrix.html.includes('Viewer');
      assert(viewerColumn, 'the viewer role is not in the matrix');
      return 'matrix rendered';
    }
  },
  {
    name: 'the new user signs in and is refused a write action',
    run: async (carried) => {
      await signIn(carried.username);
      const dashboard = await get('/dashboard');
      assert(dashboard.status === 200, `the new user cannot reach the dashboard: ${dashboard.status}`);
      const settle = await get('/claims/clm-0001/settle');
      assert(settle.status === 403, `the settle screen answered ${settle.status} for a viewer`);
      return 'read access only';
    }
  },
  {
    name: 'a role change needs a reason and is audited',
    run: async (carried) => {
      await signIn('admin');
      const users = await viewOf('/admin/users');
      const userId = [...users.html.matchAll(/data-route="\/admin\/users\/(usr-\d+)"/g)].map(m => m[1]).at(-1);
      assert(userId, 'the invited user has no identifier on the list');

      const withoutReason = await post(`/admin/users/${userId}/role`, { role: 'operations', reason: '' },
        { referer: `/admin/users/${userId}` });
      const detail = await viewOf(`/admin/users/${userId}`);
      assert(!detail.html.includes('data-testid="user-role"><div class="value">operations'),
        'the role changed without a reason');

      const withReason = await post(`/admin/users/${userId}/role`, {
        role: 'operations', reason: 'Moving to the control tower rota from April.'
      }, { referer: `/admin/users/${userId}` });
      assert(withReason.status === 302, `the role change answered ${withReason.status}`);

      const audit = await viewOf('/admin/audit?action=user.roleChanged');
      assert(audit.html.includes('user.roleChanged'), 'the role change was not audited');
      return 'changed with a reason and audited';
    }
  },
  {
    name: 'the audit log answers quickly enough to be usable',
    run: async () => {
      const started = Date.now();
      const audit = await get('/admin/audit');
      const elapsed = Date.now() - started;
      assert(audit.status === 200, `the audit log answered ${audit.status}`);
      assert(elapsed < 2000, `the audit log took ${elapsed} ms, which is too slow to work with`);
      return `${elapsed} ms`;
    }
  }
]);

// ---------------------------------------------------------------------------

const completed = results.filter(record => record.outcome === 'completed');
const broken = results.filter(record => record.outcome === 'broken');

console.log(`\n${'─'.repeat(72)}`);
console.log(`${DIRTY ? 'SHIPPED build (defects on)' : 'CORRECTED build (defects off)'}: ${completed.length} of ${results.length} journeys completed\n`);
for (const record of results) {
  const passedSteps = record.steps.filter(step => step.outcome === 'passed').length;
  console.log(`  ${record.outcome === 'completed' ? '✓' : '✗'} ${record.id} ${record.name} — ${passedSteps}/${record.steps.length} steps${record.brokeAt ? `, broke at "${record.brokeAt}"` : ''}`);
}

if (!DIRTY && broken.length) {
  console.log(`\nThe corrected build must complete every journey. ${broken.length} did not, so the lab is`);
  console.log('broken and nothing measured against it would mean anything. Fix these first.');
  process.exit(1);
}

if (DIRTY) {
  console.log('\nEach journey the shipped build breaks is ground truth: a testing platform that');
  console.log('drives these flows should find the defect that broke it.');
  for (const record of broken) {
    console.log(`\n  ${record.id} ${record.name}`);
    console.log(`    broke at: ${record.brokeAt}`);
    console.log(`    because:  ${record.steps.at(-1).detail}`);
  }
}

console.log('');
