/**
 * Stripe Webhook Handler
 * 
 * Handles Stripe webhook events and grants GitHub repository access
 * to customers upon successful payment.
 * 
 * Based on: https://dev.to/reeshee/automating-access-to-a-github-repo-using-stripe-webhooks-and-astro-endpoints-18lm
 */

import type { APIRoute } from "astro";
import Stripe from "stripe";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

// Process rawBody from the request Object
// This is needed to verify Stripe webhook signatures
async function getRawBody(request: Request): Promise<Buffer> {
    // Try multiple methods to read the body, as different environments handle it differently
    try {
        // Method 1: Try using arrayBuffer (works in most environments)
        const arrayBuffer = await request.arrayBuffer();
        return Buffer.from(arrayBuffer);
    } catch (error) {
        // Method 2: Try using the ReadableStream
        if (request.body) {
            const chunks: Uint8Array[] = [];
            const reader = request.body.getReader();

            try {
                let done = false;
                while (!done) {
                    const { done: isDone, value } = await reader.read();
                    done = isDone;
                    if (value) {
                        chunks.push(value);
                    }
                }

                const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
                const bodyData = new Uint8Array(totalLength);
                let offset = 0;
                for (const chunk of chunks) {
                    bodyData.set(chunk, offset);
                    offset += chunk.length;
                }

                return Buffer.from(bodyData);
            } finally {
                reader.releaseLock();
            }
        }

        // Method 3: Fallback to text (less ideal but works)
        const text = await request.text();
        return Buffer.from(text, 'utf8');
    }
}

// Get GitHub authentication token (supports both PAT and GitHub App)
async function getGitHubToken(): Promise<string> {
    // Try GitHub App first (recommended for production)
    const GITHUB_APP_ID = import.meta.env.GITHUB_APP_ID;
    const GITHUB_APP_PRIVATE_KEY = import.meta.env.GITHUB_APP_PRIVATE_KEY;
    const GITHUB_APP_INSTALLATION_ID = import.meta.env.GITHUB_APP_INSTALLATION_ID;

    if (GITHUB_APP_ID && GITHUB_APP_PRIVATE_KEY && GITHUB_APP_INSTALLATION_ID) {
        try {
            // Handle private key format - it might be in \n format or actual newlines
            let privateKey = GITHUB_APP_PRIVATE_KEY;
            if (privateKey.includes('\\n') && !privateKey.includes('\n')) {
                privateKey = privateKey.replace(/\\n/g, '\n');
            }

            const auth = createAppAuth({
                appId: GITHUB_APP_ID,
                privateKey: privateKey,
                installationId: GITHUB_APP_INSTALLATION_ID,
            });

            const { token } = await auth({ type: "installation" });
            console.log("✅ Using GitHub App authentication");
            return token;
        } catch (error) {
            console.error("❌ GitHub App authentication failed:", error);
            throw new Error(`GitHub App authentication failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    // Fallback to PAT (for testing, but may not work for adding collaborators)
    const GITHUB_PAT_TOKEN = import.meta.env.GITHUB_PAT_TOKEN;
    if (GITHUB_PAT_TOKEN) {
        console.log("⚠️  Using PAT token (GitHub Apps are recommended for adding collaborators)");
        return GITHUB_PAT_TOKEN;
    }

    throw new Error("GitHub authentication not configured. Please set either GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY/GITHUB_APP_INSTALLATION_ID or GITHUB_PAT_TOKEN in your .env file");
}

// Send access to a GitHub repo using custom field in Stripe checkout
async function sendAccess(
    sessionOrPayment: Stripe.Checkout.Session | Stripe.PaymentIntent
): Promise<void> {
    const GITHUB_REPO_OWNER = import.meta.env.GITHUB_REPO_OWNER;
    const GITHUB_REPO_NAME = import.meta.env.GITHUB_REPO_NAME;

    if (!GITHUB_REPO_OWNER || !GITHUB_REPO_NAME) {
        throw new Error("GitHub configuration is missing. Please set GITHUB_REPO_OWNER and GITHUB_REPO_NAME in your .env file");
    }

    // Get authentication token
    const token = await getGitHubToken();

    // Handle different event types
    let username: string | undefined;

    console.log("🔍 Looking for GitHub username in session data...");

    // Method 1: Check custom_fields (from checkout session)
    if ('custom_fields' in sessionOrPayment && sessionOrPayment.custom_fields) {
        console.log("   Found custom_fields:", sessionOrPayment.custom_fields);
        const githubField = sessionOrPayment.custom_fields.find(
            (field) => field.key === 'githubusername' ||
                field.key === 'GitHub Username' ||
                field.key?.toLowerCase() === 'githubusername'
        );
        if (githubField) {
            console.log("   Found GitHub field:", githubField);
            if ('text' in githubField && githubField.text?.value) {
                username = githubField.text.value;
                console.log("   ✅ Found username in custom_fields:", username);
            }
        }
    }

    // Method 2: Check metadata (alternative approach)
    if (!username && 'metadata' in sessionOrPayment && sessionOrPayment.metadata) {
        console.log("   Checking metadata:", sessionOrPayment.metadata);
        username = sessionOrPayment.metadata.github_username ||
            sessionOrPayment.metadata['GitHub Username'] ||
            sessionOrPayment.metadata.githubusername;
        if (username) {
            console.log("   ✅ Found username in metadata:", username);
        }
    }

    if (!username) {
        console.error("❌ GitHub username not found!");
        console.error("   Available custom_fields:", 'custom_fields' in sessionOrPayment ? sessionOrPayment.custom_fields : 'none');
        console.error("   Available metadata:", 'metadata' in sessionOrPayment ? sessionOrPayment.metadata : 'none');
        throw new Error("GitHub username not found in payment data. The test event from Stripe CLI doesn't include custom fields. Create a real checkout session with a custom field, or use metadata to test.");
    }

    // Grant access to the GitHub repository using Octokit
    console.log(`🔗 Adding collaborator to GitHub repository`);
    console.log(`📝 Username: ${username}`);
    console.log(`📦 Repo: ${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}`);

    // Use Octokit for better error handling and GitHub App support
    const octokit = new Octokit({
        auth: token,
    });

    try {
        console.log(`🔐 Attempting to add collaborator with token type: ${token.substring(0, 4)}...`);
        const result = await octokit.repos.addCollaborator({
            owner: GITHUB_REPO_OWNER,
            repo: GITHUB_REPO_NAME,
            username: username,
            permission: "read",
        });

        console.log(`✅ Successfully granted access to ${username} for ${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}`);
        console.log(`📊 GitHub API response status: ${result.status}`);
    } catch (error) {
        // Handle case where user is already a collaborator (Octokit returns 204 as success)
        const errorStatus = error && typeof error === 'object' && 'status' in error ? (error as { status: number }).status : undefined;
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorResponse = error && typeof error === 'object' && 'response' in error ? (error as { response: any }).response : undefined;

        console.error(`❌ GitHub API error details:`);
        console.error(`   Status: ${errorStatus || 'Unknown'}`);
        console.error(`   Message: ${errorMessage}`);
        if (errorResponse) {
            console.error(`   Response data:`, JSON.stringify(errorResponse.data, null, 2));
        }

        if (errorStatus === 204) {
            console.log(`✅ User ${username} is already a collaborator on ${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}`);
            return;
        }

        // Provide helpful error messages for common issues
        if (errorStatus === 404) {
            throw new Error(`Repository not found: ${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}. Check that the repo exists and your GitHub App has access.`);
        } else if (errorStatus === 403) {
            throw new Error(`Permission denied. Your GitHub App needs 'Administration: Read and write' permission. Error: ${errorMessage}`);
        } else if (errorStatus === 422) {
            throw new Error(`Invalid request. The user '${username}' might not exist on GitHub, or they're already a collaborator. Error: ${errorMessage}`);
        } else {
            throw new Error(`GitHub API error: ${errorStatus || 'Unknown'} - ${errorMessage}`);
        }
    }
}

export const POST: APIRoute = async ({ request }) => {
    try {
        const STRIPE_SECRET_KEY = import.meta.env.STRIPE_SECRET_KEY;
        const STRIPE_WEBHOOK_SIG = import.meta.env.STRIPE_WEBHOOK_SIG;
        const GITHUB_REPO_OWNER = import.meta.env.GITHUB_REPO_OWNER;
        const GITHUB_REPO_NAME = import.meta.env.GITHUB_REPO_NAME;

        // Check for GitHub App OR PAT token (GitHub App is preferred)
        const GITHUB_APP_ID = import.meta.env.GITHUB_APP_ID;
        const GITHUB_APP_PRIVATE_KEY = import.meta.env.GITHUB_APP_PRIVATE_KEY;
        const GITHUB_APP_INSTALLATION_ID = import.meta.env.GITHUB_APP_INSTALLATION_ID;
        const GITHUB_PAT_TOKEN = import.meta.env.GITHUB_PAT_TOKEN;

        const hasGitHubApp = GITHUB_APP_ID && GITHUB_APP_PRIVATE_KEY && GITHUB_APP_INSTALLATION_ID;
        const hasGitHubPAT = !!GITHUB_PAT_TOKEN;
        const hasGitHubAuth = hasGitHubApp || hasGitHubPAT;

        if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SIG) {
            console.error("Missing required Stripe environment variables");
            return new Response(
                JSON.stringify({ error: "Server configuration error: Missing Stripe credentials" }),
                {
                    status: 500,
                    headers: { "Content-Type": "application/json" },
                }
            );
        }

        if (!GITHUB_REPO_OWNER || !GITHUB_REPO_NAME) {
            console.error("Missing required GitHub repository configuration");
            return new Response(
                JSON.stringify({ error: "Server configuration error: Missing GitHub repository configuration" }),
                {
                    status: 500,
                    headers: { "Content-Type": "application/json" },
                }
            );
        }

        if (!hasGitHubAuth) {
            console.error("Missing GitHub authentication. Need either GitHub App (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID) or GITHUB_PAT_TOKEN");
            return new Response(
                JSON.stringify({ error: "Server configuration error: Missing GitHub authentication" }),
                {
                    status: 500,
                    headers: { "Content-Type": "application/json" },
                }
            );
        }

        const stripe = new Stripe(STRIPE_SECRET_KEY, {
            apiVersion: "2025-12-15.clover",
        });

        // IMPORTANT: Read headers BEFORE reading the body
        // Some environments consume the request when reading the body
        const sig = request.headers.get("stripe-signature") ||
            request.headers.get("Stripe-Signature") ||
            request.headers.get("STRIPE-SIGNATURE");

        // Debug: log all headers to help troubleshoot
        const allHeaders: Record<string, string> = {};
        request.headers.forEach((value: string, key: string) => {
            allHeaders[key] = value;
        });
        console.log("📋 Received headers:", Object.keys(allHeaders));
        console.log("🔍 Looking for stripe-signature header...");
        console.log("📋 Full request details:", {
            url: request.url,
            method: request.method,
            headersCount: Array.from(request.headers.keys()).length
        });

        if (!sig) {
            console.error("❌ Missing stripe-signature header. Available headers:", Object.keys(allHeaders));
            console.error("📋 All header values:", allHeaders);

            return new Response(
                JSON.stringify({
                    error: "Missing stripe-signature header",
                    availableHeaders: Object.keys(allHeaders),
                    headerValues: allHeaders
                }),
                {
                    status: 400,
                    headers: { "Content-Type": "application/json" },
                }
            );
        }

        console.log("✅ Found stripe-signature header");

        // Get raw body for signature verification (after reading headers)
        const rawBody = await getRawBody(request);

        // Verify Stripe Signature to protect the endpoint
        let event: Stripe.Event;
        try {
            event = stripe.webhooks.constructEvent(
                rawBody,
                sig,
                STRIPE_WEBHOOK_SIG
            );
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : "Unknown error";
            console.error("Webhook signature verification failed:", errorMessage);
            return new Response(
                JSON.stringify({ error: `Webhook Error: ${errorMessage}` }),
                {
                    status: 400,
                    headers: { "Content-Type": "application/json" },
                }
            );
        }

        // Handle different event types
        if (event.type === "checkout.session.completed") {
            let session = event.data.object as Stripe.Checkout.Session;

            // In production, custom_fields might not be included in the webhook event
            // We need to retrieve the full session from Stripe API
            try {
                const expandedSession = await stripe.checkout.sessions.retrieve(session.id, {
                    expand: ['custom_fields']
                });
                session = expandedSession;
                console.log("📦 Retrieved full session from Stripe API");
            } catch (retrieveError) {
                console.warn("⚠️  Could not retrieve expanded session, using event data:", retrieveError instanceof Error ? retrieveError.message : String(retrieveError));
            }

            // Log the session data for debugging
            console.log("📦 Checkout session received:");
            console.log("   Session ID:", session.id);
            console.log("   Custom fields:", JSON.stringify(session.custom_fields, null, 2));
            console.log("   Metadata:", JSON.stringify(session.metadata, null, 2));
            console.log("   Full session keys:", Object.keys(session));

            try {
                console.log("🚀 Starting GitHub access grant process...");
                await sendAccess(session);
                console.log("✅ GitHub access process completed successfully");
                return new Response(
                    JSON.stringify({
                        received: true,
                        event: event.type,
                        message: "GitHub access granted successfully"
                    }),
                    {
                        status: 200,
                        headers: { "Content-Type": "application/json" },
                    }
                );
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : "Unknown error";
                const errorStack = error instanceof Error ? error.stack : undefined;
                console.error("❌ Error granting GitHub access:");
                console.error("   Message:", errorMessage);
                console.error("   Session ID:", session.id);
                console.error("   Custom fields available:", !!session.custom_fields);
                console.error("   Metadata available:", !!session.metadata);
                if (errorStack) {
                    console.error("   Stack:", errorStack);
                }

                // Return 200 to acknowledge receipt, but log the error
                // This prevents Stripe from retrying, but we should monitor logs
                return new Response(
                    JSON.stringify({
                        received: true,
                        event: event.type,
                        error: errorMessage,
                        warning: "Webhook received but GitHub access failed - check server logs",
                        sessionId: session.id
                    }),
                    {
                        status: 200,
                        headers: { "Content-Type": "application/json" },
                    }
                );
            }
        }

        if (event.type === "payment_intent.succeeded") {
            // For payment_intent, we need to retrieve the checkout session
            // to get the custom fields. This is a more complex scenario.
            // For now, we'll log it and suggest using checkout.session.completed instead.
            console.log("payment_intent.succeeded received, but custom fields are in the checkout session");
            return new Response(
                JSON.stringify({
                    received: true,
                    event: event.type,
                    message: "Consider using checkout.session.completed event instead for custom fields"
                }),
                {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                }
            );
        }

        // Return success for other event types (we just acknowledge receipt)
        return new Response(
            JSON.stringify({ received: true, event: event.type }),
            {
                status: 200,
                headers: { "Content-Type": "application/json" },
            }
        );
    } catch (error) {
        console.error("Webhook handler error:", error);
        const errorMessage = error instanceof Error ? error.message : "Internal server error";
        const errorDetails = error instanceof Error ? error.toString() : String(error);
        return new Response(
            JSON.stringify({
                error: errorMessage,
                details: errorDetails
            }),
            {
                status: 500,
                headers: { "Content-Type": "application/json" },
            }
        );
    }
};
