import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function cleanText(value: unknown, limit: number) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, limit);
}

function cleanPhone(value: unknown) {
  return String(value || "").replace(/\D/g, "");
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return response({ error: "Method not allowed" }, 405);

  const authorization = request.headers.get("Authorization") || "";
  const accessToken = authorization.replace(/^Bearer\s+/i, "");
  if (!accessToken) return response({ error: "Sign in before continuing." }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return response({ error: "Supabase account management is not configured." }, 500);
  }

  const callerClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authError } = await callerClient.auth.getUser(accessToken);
  if (authError || !authData.user) return response({ error: "Your session is invalid or expired." }, 401);

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const callerUid = authData.user.id;

  try {
    const body = await request.json();
    const action = cleanText(body.action, 32);
    const clubId = cleanText(body.clubId, 128);
    const { data: membership, error: membershipError } = await admin
      .from("club_owners")
      .select("club_id")
      .eq("club_id", clubId)
      .eq("owner_uid", callerUid)
      .maybeSingle();
    if (membershipError) throw membershipError;
    if (!membership) return response({ error: "Club owner access is required." }, 403);

    if (action === "customer-create") {
      const username = cleanText(body.username, 30).toLowerCase();
      const password = String(body.password || "");
      const customerId = cleanText(body.customerId, 128);
      const customerName = cleanText(body.customerName, 80);
      const mobile = cleanPhone(body.mobile);
      const revision = Math.max(1, Math.min(10, Number(body.revision) || 1));
      if (!/^[a-z0-9][a-z0-9_-]{1,28}[a-z0-9]$/.test(username) ||
          !/^\d{8,15}$/.test(mobile) || password.length < 6 ||
          !customerId || !customerName) {
        return response({ error: "Valid customer login details are required." }, 400);
      }

      const { data: ledgerRow, error: ledgerError } = await admin
        .from("club_ledgers")
        .select("ledger")
        .eq("club_id", clubId)
        .maybeSingle();
      if (ledgerError) throw ledgerError;
      const customer = (ledgerRow?.ledger?.customers || []).find(
        (entry: Record<string, unknown>) => entry.id === customerId && !entry.deleted,
      );
      if (!customer || cleanPhone(customer.phone) !== mobile) {
        return response({ error: "That customer record could not be verified." }, 403);
      }
      if (customer.login?.uid) {
        return response({ error: "This customer already has a login. Reset or remove it first." }, 409);
      }

      const identity = cleanPhone(username) || username;
      const suffix = revision > 1 ? "-r" + revision : "";
      const email = identity + "+" + clubId + suffix + "@customer.club-ledger.app";
      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { role: "customer", club_id: clubId },
      });
      if (createError) return response({ error: createError.message, code: createError.code }, 409);

      const { error: registrationError } = await admin.from("customer_registrations").insert({
        user_uid: created.user.id,
        club_id: clubId,
        customer_name: customerName,
        mobile,
        status: "linked",
        linked_customer_id: customerId,
      });
      if (registrationError) {
        await admin.auth.admin.deleteUser(created.user.id);
        throw registrationError;
      }
      return response({ uid: created.user.id, email, revision });
    }

    if (action === "customer-reset" || action === "customer-remove") {
      const customerUid = cleanText(body.customerUid, 128);
      const customerId = cleanText(body.customerId, 128);
      if (!customerUid || !customerId) return response({ error: "Customer login details are required." }, 400);
      const { data: registration, error: registrationLookupError } = await admin
        .from("customer_registrations")
        .select("user_uid")
        .eq("user_uid", customerUid)
        .eq("club_id", clubId)
        .eq("linked_customer_id", customerId)
        .maybeSingle();
      if (registrationLookupError) throw registrationLookupError;
      if (!registration) return response({ error: "That customer does not belong to your club." }, 403);

      const { data: ledgerRow, error: ledgerError } = await admin
        .from("club_ledgers")
        .select("ledger")
        .eq("club_id", clubId)
        .maybeSingle();
      if (ledgerError) throw ledgerError;
      const customer = (ledgerRow?.ledger?.customers || []).find(
        (entry: Record<string, unknown>) =>
          entry.id === customerId && !entry.deleted &&
          (entry.login as Record<string, unknown> | undefined)?.uid === customerUid,
      );
      if (!customer) return response({ error: "That customer login could not be verified." }, 403);

      if (action === "customer-reset") {
        const password = String(body.password || "");
        if (password.length < 6) return response({ error: "Password must be at least 6 characters." }, 400);
        const { error } = await admin.auth.admin.updateUserById(customerUid, { password });
        if (error) throw error;
        return response({ uid: customerUid, reset: true });
      }

      const { error: portalError } = await admin.from("customer_portals").delete().eq("customer_uid", customerUid);
      if (portalError) throw portalError;
      const { error: registrationError } = await admin.from("customer_registrations").delete().eq("user_uid", customerUid);
      if (registrationError) throw registrationError;
      const { error: deleteError } = await admin.auth.admin.deleteUser(customerUid);
      if (deleteError) throw deleteError;
      return response({ uid: customerUid, removed: true });
    }

    if (action === "owner-add") {
      const mobile = cleanPhone(body.mobile);
      const ownerName = cleanText(body.ownerName, 80);
      const password = String(body.password || "");
      if (!/^\d{8,15}$/.test(mobile) || !ownerName || password.length < 6) {
        return response({ error: "Valid owner details and a password are required." }, 400);
      }
      const email = mobile + "@owner.club-ledger.app";
      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { role: "owner", club_id: clubId },
      });
      if (createError) return response({ error: createError.message, code: createError.code }, 409);

      const { error: ownerError } = await admin.from("club_owners").insert({
        club_id: clubId,
        owner_uid: created.user.id,
        owner_name: ownerName,
        mobile,
      });
      if (ownerError) {
        await admin.auth.admin.deleteUser(created.user.id);
        throw ownerError;
      }
      return response({ uid: created.user.id, email });
    }

    return response({ error: "Unsupported account operation." }, 400);
  } catch (error) {
    console.error("Account management failed:", error);
    return response({ error: error instanceof Error ? error.message : "Account management failed." }, 500);
  }
});
