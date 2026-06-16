// Supabase Edge Function — สร้าง Stripe Checkout Session
// deploy: supabase functions deploy create-checkout-session --no-verify-jwt
import Stripe from "https://esm.sh/stripe@14?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!);
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const appUrl = Deno.env.get("APP_URL") || "http://localhost:5000";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization")!;
    const token = authHeader.replace("Bearer ", "");

    // ตรวจสอบตัวตนของผู้ใช้
    const sb = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false },
    });
    const { data: { user }, error: authError } = await sb.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { planId, billingCycle, shopId } = await req.json();

    // ตรวจสอบว่าผู้ใช้มีบทบาทเป็นสมาชิกหรือเจ้าของร้านค้านี้จริง
    const { data: membership, error: memError } = await sb
      .from("memberships")
      .select("role")
      .eq("user_id", user.id)
      .eq("shop_id", shopId)
      .single();

    if (memError || !membership || (membership.role !== "owner" && membership.role !== "superadmin")) {
      return new Response(JSON.stringify({ error: "Forbidden: Only shop owners can purchase subscriptions" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ดึงข้อมูลแผนราคา (Plan) จากฐานข้อมูล
    const { data: plan, error: planError } = await sb
      .from("plans")
      .select("*")
      .eq("id", planId)
      .single();

    if (planError || !plan) {
      return new Response(JSON.stringify({ error: "Plan not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const priceAmount = billingCycle === "year" ? plan.price_year : plan.price_month;
    const interval = billingCycle === "year" ? "year" : "month";

    // สร้าง Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "thb",
            product_data: {
              name: `Recipro Plan: ${plan.name}`,
              description: `แพ็กเกจสำหรับร้านค้า (ตัดจ่ายราย${interval === "year" ? "ปี" : "เดือน"})`,
            },
            unit_amount: Math.round(priceAmount * 100), // แปลงเป็นสตางค์
            recurring: {
              interval: interval,
            },
          },
          quantity: 1,
        },
      ],
      mode: "subscription",
      success_url: `${appUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/?checkout=cancel`,
      metadata: {
        shop_id: shopId,
        plan_id: planId,
        billing_cycle: billingCycle,
      },
    });

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
