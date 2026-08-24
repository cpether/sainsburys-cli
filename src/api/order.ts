import type { GroceriesClient } from "../client/http.js";
import type { Order, OrderListResponse, OrderStatus } from "./types.js";

const BASE = "/groceries-api/gol-services/order/v1/order";

export interface ListOrdersArgs {
  pageSize?: number;
  pageNumber?: number;
}

export async function listOrders(
  client: GroceriesClient,
  args: ListOrdersArgs = {},
): Promise<OrderListResponse> {
  return client.request<OrderListResponse>(BASE, {
    query: {
      page_size: args.pageSize ?? 10,
      page_number: args.pageNumber ?? 1,
    },
  });
}

export async function getOrder(
  client: GroceriesClient,
  orderId: string,
  opts: { placed?: boolean; deliveryPass?: boolean } = {},
): Promise<Order> {
  return client.request<Order>(`${BASE}/${encodeURIComponent(orderId)}`, {
    query: {
      placed: opts.placed ?? true,
      deliveryPass: opts.deliveryPass ?? false,
    },
  });
}

/**
 * Active in-flight order summary; null when no current order (the BFF returns
 * either an empty body or HTTP 404 in that case — both are treated as "no active").
 */
export async function getActiveOrderStatus(
  client: GroceriesClient,
): Promise<OrderStatus | null> {
  let result: OrderStatus | "" | null | undefined;
  try {
    result = await client.request<OrderStatus | "" | null | undefined>(`${BASE}/status`);
  } catch (err) {
    if (err && typeof err === "object" && "status" in err && (err as { status: number }).status === 404) {
      return null;
    }
    throw err;
  }
  if (!result || typeof result !== "object" || !("order_uid" in result)) return null;
  return result;
}

/**
 * Flip an order into amend mode. Empty body, empty response. Side effect:
 * subsequent GET /basket returns the order's items as an editable basket.
 */
export async function startAmend(client: GroceriesClient, orderId: string): Promise<void> {
  await client.request<void>(`${BASE}/${encodeURIComponent(orderId)}/amend`, {
    method: "POST",
    body: {},
  });
}
