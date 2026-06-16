// Supabase Edge Function — งานของ Superadmin (สร้างร้านใหม่ + สมัครไอดีคนแรกให้ร้าน)
// deploy: supabase functions deploy admin-tasks --no-verify-jwt
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

    // ตรวจสอบตัวตนผู้ใช้ที่เรียก
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

    // ตรวจสอบบทบาทว่าเป็น superadmin หรือไม่
    const { data: adminCheck, error: checkError } = await sb
      .from("memberships")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "superadmin")
      .maybeSingle();

    if (checkError || !adminCheck) {
      return new Response(JSON.stringify({ error: "Forbidden: Superadmin access required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { action, shopName, ownerEmail, ownerPassword } = await req.json();

    if (action === "create_shop") {
      if (!shopName || !ownerEmail || !ownerPassword) {
        return new Response(JSON.stringify({ error: "Missing required parameters" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // 1. สร้างร้านค้าใหม่
      const { data: shop, error: shopError } = await sb
        .from("shops")
        .insert({ name: shopName, status: "trial" })
        .select()
        .single();

      if (shopError || !shop) {
        throw new Error(`Failed to create shop: ${shopError.message}`);
      }

      // 2. สร้างบัญชีเจ้าของร้านแรก (Owner)
      const { data: newOwner, error: userError } = await sb.auth.admin.createUser({
        email: ownerEmail,
        password: ownerPassword,
        email_confirm: true,
      });

      if (userError || !newOwner.user) {
        // หากสร้าง User ไม่สำเร็จ ให้ลบร้านค้าที่พึ่งสร้างเพื่อความสะอาด
        await sb.from("shops").delete().eq("id", shop.id);
        throw new Error(`Failed to create owner user: ${userError?.message || "unknown"}`);
      }

      // 3. สร้าง Membership เชื่อมโยงเจ้าของกับร้านค้า
      const { error: membError } = await sb
        .from("memberships")
        .insert({
          user_id: newOwner.user.id,
          shop_id: shop.id,
          role: "owner",
        });

      if (membError) {
        // คลีนอัพ
        await sb.from("shops").delete().eq("id", shop.id);
        await sb.auth.admin.deleteUser(newOwner.user.id);
        throw new Error(`Failed to bind membership: ${membError.message}`);
      }

      // 4. สร้าง Shop Settings ตั้งต้น
      await sb.from("shop_settings").insert({
        shop_id: shop.id,
        theme: "rose",
      });

      return new Response(JSON.stringify({ success: true, shopId: shop.id, userId: newOwner.user.id }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unsupported action" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
