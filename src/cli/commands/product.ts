import { Command } from "commander";
import {
  getProductsByUid,
  searchProducts,
  searchSuggestions,
  type ProductQueryContext,
} from "../../api/product.js";
import type { Product } from "../../api/types.js";
import { buildContext } from "../context.js";
import { exitCodeFor, formatMoney, printData, printError } from "../output.js";

function renderProductRow(p: Product): string {
  const price = p.retail_price?.price;
  const unit = p.unit_price ? `${formatMoney(p.unit_price.price)}/${p.unit_price.measure}` : "";
  return `${p.product_uid.padEnd(8)} ${formatMoney(price).padStart(7)} ${unit.padEnd(14)} ${
    p.is_available === false ? "[oos] " : "      "
  }${p.name}`;
}

function ctxFromCli(storeNumber: string, opts: { slotDate?: string; slotType?: string }): ProductQueryContext {
  return {
    storeIdentifier: storeNumber,
    slotDate: opts.slotDate,
    slotType: (opts.slotType as "delivery" | "collection" | undefined) ?? undefined,
  };
}

export function productCommand(): Command {
  const cmd = new Command("product").description("Search and look up products");

  cmd
    .command("search <query...>")
    .description("Keyword search the catalogue")
    .option("-n, --page-size <n>", "Page size (30|60|90, default 30)", (v) => Number(v), 30)
    .option("-p, --page <n>", "Page number (default 1)", (v) => Number(v), 1)
    .option("--slot-date <yyyy-mm-dd>", "Slot date for availability/pricing")
    .option("--slot-type <type>", "delivery|collection")
    .action(
      async (
        query: string[],
        opts: { pageSize: number; page: number; slotDate?: string; slotType?: string },
        cmdRef,
      ) => {
        try {
          const c = await buildContext(cmdRef);
          const result = await searchProducts(c.client, {
            keyword: query.join(" "),
            ctx: ctxFromCli(c.storeNumber, opts),
            pageSize: opts.pageSize,
            pageNumber: opts.page,
          });
          printData(c, result, () => {
            const rows = (result.products ?? []).map(renderProductRow).join("\n");
            const total = result.controls?.total_record_count;
            const header = total !== undefined ? `${total} matches\n` : "";
            return header + rows;
          });
        } catch (err) {
          printError(err);
          process.exit(exitCodeFor(err));
        }
      },
    );

  cmd
    .command("get <skus...>")
    .description("Bulk fetch products by SKU (product_uid)")
    .option("--slot-date <yyyy-mm-dd>", "Slot date for availability/pricing")
    .option("--slot-type <type>", "delivery|collection")
    .option("--minimised", "Request the minimised payload", false)
    .action(
      async (
        skus: string[],
        opts: { slotDate?: string; slotType?: string; minimised: boolean },
        cmdRef,
      ) => {
        try {
          const c = await buildContext(cmdRef);
          const result = await getProductsByUid(c.client, {
            uids: skus,
            ctx: ctxFromCli(c.storeNumber, opts),
            minimised: opts.minimised,
          });
          printData(c, result, () =>
            (result.products ?? []).map(renderProductRow).join("\n"),
          );
        } catch (err) {
          printError(err);
          process.exit(exitCodeFor(err));
        }
      },
    );

  cmd
    .command("suggest <query...>")
    .description("Autocomplete suggestions for a search query")
    .action(async (query: string[], _opts, cmdRef) => {
      try {
        const c = await buildContext(cmdRef);
        const result = await searchSuggestions(c.client, query.join(" "));
        printData(c, result, () => (result.length ? result.join("\n") : "(no suggestions)"));
      } catch (err) {
        printError(err);
        process.exit(exitCodeFor(err));
      }
    });

  return cmd;
}
