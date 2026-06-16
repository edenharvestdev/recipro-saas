// Supabase Edge Function — รับ webhook จาก Stripe (ตัดบัตร/ต่ออายุ/บัตรเด้ง)
// deploy: supabase functions deploy stripe-webhook --no-verify-jwt
import Stripe from "https://esm.sh/stripe@14?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!);
const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")! // server key: ข้าม RLS เพื่อแก้สถานะได้ทุกตาราง
);

Deno.serve(async (req) => {
  const sig = req.headers.get("stripe-signature")!;
  const body = await req.text();
  let event;

  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      sig,
      Deno.env.get("STRIPE_WEBHOOK_SECRET")!
    );
  } catch (err) {
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  try {
    switch (event.type) {
      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = invoice.subscription as string;

        if (subscriptionId) {
          // ดึงรายละเอียด Subscription เพื่อดูวันหมดอายุรอบบิลใหม่
          const sub = await stripe.subscriptions.retrieve(subscriptionId);
          const currentPeriodEnd = new Date(sub.current_period_end * 1000).toISOString();

          // 1. ค้นหาแถวของ Subscription ในระบบของเราเพื่อดึง shop_id
          const { data: localSub, error: findError } = await sb
            .from("subscriptions")
            .select("shop_id")
            .eq("provider_sub_id", subscriptionId)
            .maybeSingle();

          let targetShopId = localSub?.shop_id;

          // หากยังไม่เคยบันทึก Subscription มาก่อน (เช่นจ่ายเงินครั้งแรก)
          // ให้ดึง metadata ที่แนบตอนเปิด checkout session
          if (!targetShopId && sub.metadata?.shop_id) {
            targetShopId = sub.metadata.shop_id;

            // ตรวจสอบหรือสร้างแถว Subscription ตั้งต้น
            await sb.from("subscriptions").upsert({
              shop_id: targetShopId,
              plan_id: sub.metadata.plan_id,
              status: "active",
              billing_cycle: sub.metadata.billing_cycle || "month",
              current_period_end: currentPeriodEnd,
              provider: "stripe",
              provider_customer_id: sub.customer as string,
              provider_sub_id: subscriptionId,
            });
          } else if (targetShopId) {
            // อัปเดตสถานะ Subscription เดิม
            await sb
              .from("subscriptions")
              .update({
                status: "active",
                current_period_end: currentPeriodEnd,
              })
              .eq("provider_sub_id", subscriptionId);
          }

          if (targetShopId) {
            // 2. ปรับสถานะร้านค้าเป็น 'active'
            await sb
              .from("shops")
              .update({ status: "active" })
              .eq("id", targetShopId);

            // 3. บันทึกประวัติการจ่ายเงินลงตาราง payments
            await sb.from("payments").insert({
              shop_id: targetShopId,
              amount: invoice.amount_paid / 100, // แปลงสตางค์เป็นบาท
              currency: invoice.currency.toUpperCase(),
              status: "paid",
              paid_at: new Date().toISOString(),
              provider_invoice_id: invoice.id,
            });
          }
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = invoice.subscription as string;

        if (subscriptionId) {
          const { data: localSub } = await sb
            .from("subscriptions")
            .select("shop_id")
            .eq("provider_sub_id", subscriptionId)
            .maybeSingle();

          if (localSub) {
            // ปรับสถานะเป็น past_due
            await sb
              .from("subscriptions")
              .update({ status: "past_due" })
              .eq("provider_sub_id", subscriptionId);

            // ปรับสถานะร้านค้าเป็น suspended เพื่อแสดงหน้าแจ้งเตือนค้างชำระ
            await sb
              .from("shops")
              .update({ status: "suspended" })
              .eq("id", localSub.shop_id);
          }
        }
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const subscriptionId = sub.id;

        const { data: localSub } = await sb
          .from("subscriptions")
          .select("shop_id")
          .eq("provider_sub_id", subscriptionId)
          .maybeSingle();

        if (localSub) {
          // ปรับสถานะเป็น canceled
          await sb
            .from("subscriptions")
            .update({ status: "canceled" })
            .eq("provider_sub_id", subscriptionId);

          // ระงับการใช้บริการของร้านค้า
          await sb
            .from("shops")
            .update({ status: "suspended" })
            .eq("id", localSub.shop_id);
        }
        break;
      }
    }

    return new Response("ok", { status: 200 });
  } catch (err) {
    return new Response(`Error: ${err.message}`, { status: 500 });
  }
});
