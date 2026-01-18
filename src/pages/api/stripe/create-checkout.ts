/**
 * Create Stripe Checkout Session with Custom Fields
 * 
 * Example endpoint showing how to create a Stripe Checkout Session
 * with a GitHub Username custom field.
 * 
 * Usage:
 * POST /api/stripe/create-checkout
 * Body: { priceId: "price_xxx", successUrl: "https://...", cancelUrl: "https://..." }
 */

import type { APIRoute } from "astro";
import Stripe from "stripe";

export const POST: APIRoute = async ({ request }) => {
  try {
    const STRIPE_SECRET_KEY = import.meta.env.STRIPE_SECRET_KEY;

    if (!STRIPE_SECRET_KEY) {
      return new Response(
        JSON.stringify({ error: "Stripe secret key not configured" }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const stripe = new Stripe(STRIPE_SECRET_KEY, {
      apiVersion: "2025-12-15.clover",
    });

    const body = await request.json();
    const { priceId, successUrl, cancelUrl } = body;

    if (!priceId || !successUrl || !cancelUrl) {
      return new Response(
        JSON.stringify({ 
          error: "Missing required fields: priceId, successUrl, cancelUrl" 
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Create Checkout Session with custom field for GitHub Username
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      // Add custom field for GitHub Username
      custom_fields: [
        {
          key: "githubusername", // Internal identifier (lowercase, no spaces)
          label: {
            type: "custom",
            custom: "GitHub Username", // What the customer sees
          },
          type: "text", // Can be "text", "numeric", or "dropdown"
          optional: false, // Make it required
        },
      ],
      // Optional: Add metadata as backup
      metadata: {
        // You can add other metadata here if needed
      },
    });

    return new Response(
      JSON.stringify({ 
        sessionId: session.id,
        url: session.url 
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Error creating checkout session:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: errorMessage }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
};
