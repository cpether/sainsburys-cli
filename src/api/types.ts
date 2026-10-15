export interface BasketItem {
  product_uid?: string;
  /**
   * 8-char alphanumeric SKU (e.g. "5mhzwp13"). The basket GET response uses this
   * instead of `product_uid` — numeric SKU is only on add/update request bodies.
   */
  sain_id?: string;
  quantity: number;
  uom: string;
  selected_catchweight?: string;
  item_uid?: string;
  sub_total?: number;
  subtotal_price?: number;
  product?: Product;
}

export interface Basket {
  basket_id: string;
  order_id: string;
  subtotal_price: number;
  total_price: number;
  savings: number;
  vouchers_savings: number;
  minimum_spend: number;
  has_exceeded_minimum_spend: boolean;
  is_in_amend_mode: boolean;
  item_count: number;
  items: BasketItem[];
  delivery_instructions: string;
  promo_savings: number;
  nectar_savings: number;
  your_nectar_savings: number;
  error?: { code: string; message: string }[];
}

export interface Product {
  product_uid: string;
  sainId?: string;
  /** Numeric SKU. Present on the nested product of basket items, where product_uid isn't. */
  sku?: string;
  name: string;
  full_url?: string;
  product_type?: string;
  is_available?: boolean;
  retail_price?: { price: number; measure?: string; measure_amount?: number };
  unit_price?: { price: number; measure: string; measure_amount: number };
  image_url?: string;
  product_url?: string;
  eans?: string[];
  promotions?: unknown[];
  reviews?: { is_enabled?: boolean; total?: number; average_rating?: number };
  [key: string]: unknown;
}

export interface ProductListResponse {
  products: Product[];
  controls?: {
    sort?: { active?: string; options?: { id: string; name: string }[] };
    page?: { current?: number; total?: number; size?: number; size_options?: number[] };
    filters?: unknown;
    total_record_count?: number;
    returned_record_count?: number;
  };
  suggested_search_terms?: string[];
}

export interface OrderStatus {
  order_uid: string;
  is_in_amend_mode: boolean;
  is_cutoff: boolean;
  cutoff_time?: string;
  slot_start_time?: string;
  slot_end_time?: string;
  order_type?: string;
  total?: number;
}

export interface OrderListItem {
  order_uid: string;
  status: string;
  order_type: string;
  slot_start_time: string;
  slot_end_time: string;
  total: number;
  store_identifier?: string;
  is_in_amend_mode?: boolean;
  is_cancellable?: boolean;
  is_cutoff?: boolean;
}

export interface OrderListResponse {
  orders: OrderListItem[];
  page?: { current?: number; total?: number; size?: number };
}

export interface Order extends OrderListItem {
  sub_total: number;
  address_uid: string;
  delivery_address?: unknown;
  payment?: unknown;
  order_items: BasketItem[];
}

export interface SlotReservation {
  /** May be absent only when there is no slot. */
  is_expired?: boolean;
  reservation_type: string;
  reserved_until?: string;
  postcode?: string;
  region?: string;
  store_identifier?: string;
  flexi_stores?: string[];
  slot?: {
    start_time: string;
    end_time: string;
    price: number;
    qualified_price?: number;
    unqualified_price?: number;
    is_green?: boolean;
    is_alcohol_restricted?: boolean;
    booking_key: string;
    slot_type: string;
    reservation_id: string;
  };
  delivery_address?: unknown;
}

export interface CustomerProfile {
  user_id: string;
  customer_id?: string;
  customer_number?: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  [key: string]: unknown;
}
