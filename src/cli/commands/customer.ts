import { Command } from "commander";
import { getProfile, getSlotReservation } from "../../api/customer.js";
import { buildContext } from "../context.js";
import { exitCodeFor, formatMoney, printData, printError, shortDate } from "../output.js";

export function customerCommand(): Command {
  const cmd = new Command("customer").description("Customer profile and slot info");

  cmd
    .command("profile")
    .description("Show the logged-in customer's profile")
    .action(async (_opts, cmdRef) => {
      try {
        const c = await buildContext(cmdRef);
        const profile = await getProfile(c.client);
        printData(
          c,
          profile,
          () =>
            `user_id: ${profile.user_id}\nemail: ${profile.email ?? "-"}\nname: ${profile.first_name ?? ""} ${profile.last_name ?? ""}`.trim(),
        );
      } catch (err) {
        printError(err);
        process.exit(exitCodeFor(err));
      }
    });

  cmd
    .command("slot")
    .description("Show the active slot reservation (if any)")
    .option("--order-uid <id>", "Look up the slot tied to a specific order")
    .action(async (opts: { orderUid?: string }, cmdRef) => {
      try {
        const c = await buildContext(cmdRef);
        const reservation = await getSlotReservation(c.client, opts.orderUid);
        if (!reservation) {
          printData(c, { reserved: false }, () => "no slot reservation");
          return;
        }
        printData(c, reservation, () =>
          [
            `slot:        ${shortDate(reservation.slot?.start_time)} → ${shortDate(reservation.slot?.end_time)}`,
            `type:        ${reservation.reservation_type} / ${reservation.slot?.slot_type ?? "-"}`,
            `price:       ${formatMoney(reservation.slot?.price)}`,
            `held until:  ${shortDate(reservation.reserved_until)}`,
            `postcode:    ${reservation.postcode ?? "-"}`,
            `store:       ${reservation.store_identifier ?? "-"}`,
          ].join("\n"),
        );
      } catch (err) {
        printError(err);
        process.exit(exitCodeFor(err));
      }
    });

  return cmd;
}
