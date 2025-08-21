import { Router, Request, Response } from "express";
import axios, { AxiosError } from "axios";
import Appointment from "../models/Appointment";
import { sendEmail } from "../services/emailService";

const router = Router();

// Helper to normalize names for comparison
const normalizeName = (name: string): string => {
  const normalized = name
    .replace(/^(mr|mrs|ms|dr)\.?/i, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .trim();
  console.log(`[DEBUG] normalizeName('${name}') => '${normalized}'`);
  return normalized;
};

// Helper function for retrying API calls with exponential backoff
async function verifySlipWithRetry(
  refNbr: string,
  amount: number,
  token: string,
  retries = 3
): Promise<any> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(
        `[DEBUG] Attempt ${attempt} - calling OpenSlipVerify API with refNbr=${refNbr}, amount=${amount}`
      );
      const response = await axios.post(
        "https://api.openslipverify.com/v1/verify",
        { refNbr, amount: amount.toString(), token },
        { headers: { "Content-Type": "application/json" }, timeout: 5000 }
      );
      console.log(`[DEBUG] Attempt ${attempt} - API response:`, response.data);
      return response.data;
    } catch (err: any) {
      const axiosErr = err as AxiosError;
      console.warn(`[DEBUG] Attempt ${attempt} failed:`, axiosErr.message);

      if (attempt === retries) throw err; // give up after last attempt
      const waitTime = attempt * 1000;
      console.log(`[DEBUG] Waiting ${waitTime}ms before retrying...`);
      await new Promise((r) => setTimeout(r, waitTime));
    }
  }
}

router.post("/", async (req: Request, res: Response) => {
  console.log("[DEBUG] Verification request received:", req.body);

  try {
    const { bookingID, refNbr, amount } = req.body;

    if (!bookingID || !refNbr || !amount) {
      console.log("[DEBUG] Missing required fields:", {
        bookingID,
        refNbr,
        amount,
      });
      return res
        .status(400)
        .json({ status: "failed", message: "Missing required fields" });
    }

    const token = process.env.OPEN_SLIP_VERIFY_TOKEN;
    const expectedReceiverName = process.env.PROMPTPAY_RECEIVER_NAME;

    if (!token || !expectedReceiverName) {
      console.error(
        "[DEBUG] Server misconfiguration - token or expectedReceiverName missing"
      );
      return res
        .status(500)
        .json({ status: "failed", message: "Server misconfiguration" });
    }

    console.log(
      "[DEBUG] Checking for existing appointment with this refNbr:",
      refNbr
    );
    const existingAppointment = await Appointment.findOne({
      "paymentVerification.decodedString": refNbr,
    });
    if (existingAppointment) {
      console.log("[DEBUG] Reference number already used:", refNbr);
      return res
        .status(409)
        .json({ status: "failed", message: "Reference number already used" });
    }

    // Call OpenSlipVerify API with retry
    const response = await verifySlipWithRetry(refNbr, amount, token);

    if (response?.success !== true) {
      console.log("[DEBUG] Verification unsuccessful:", response);
      return res.status(400).json({
        status: "failed",
        message: response?.msg || "Verification unsuccessful",
      });
    }

    console.log("[DEBUG] Verifying receiver name...");
    const receiver = response.data?.receiver;
    const normalizedExpectedName = normalizeName(expectedReceiverName);
    const normalizedReturnedName = normalizeName(receiver?.name || "");

    if (normalizedExpectedName !== normalizedReturnedName) {
      console.warn("[DEBUG] Receiver account mismatch:", {
        expected: normalizedExpectedName,
        got: normalizedReturnedName,
      });
      return res.status(400).json({
        status: "failed",
        message: "Receiver account mismatch",
        debug: {
          expected: normalizedExpectedName,
          got: normalizedReturnedName,
        },
      });
    }

    console.log("[DEBUG] Finding appointment by bookingID:", bookingID);
    const appointment = await Appointment.findOne({ bookingId: bookingID });
    if (!appointment) {
      console.log("[DEBUG] Appointment not found for bookingID:", bookingID);
      return res
        .status(404)
        .json({ status: "failed", message: "Appointment not found" });
    }

    console.log("[DEBUG] Updating appointment verification status");
    appointment.paymentVerification = {
      status: "verified",
      verifiedAt: new Date(),
      decodedString: refNbr,
      notes: response.statusMessage || null,
    };
    await appointment.save();
    console.log("[DEBUG] Appointment saved successfully");

    // Send confirmation email
    try {
      const { userDetails, timeSlot, amount } = appointment;
      console.log("[DEBUG] Sending confirmation email to:", userDetails.email);

      const subject = `Booking Confirmation - ${appointment.bookingId}`;
      const text = `
Dear ${userDetails.name},

Your appointment has been confirmed!

📌 Booking ID: ${appointment.bookingId}
📅 Date: ${timeSlot.date}
⏰ Time: ${timeSlot.time}
💵 Amount Paid: ${amount} THB

Thank you for booking with us.

Regards,
M-Care Team.
      `;
      await sendEmail(userDetails.email, subject, text);
      console.log(`[DEBUG] Confirmation email sent for booking ${bookingID}`);
    } catch (emailError) {
      console.error(
        `[DEBUG] Failed to send email for booking ${bookingID}:`,
        emailError
      );
    }

    console.log("[DEBUG] Returning successful response");
    return res.json({
      status: "verified",
      message: "Slip verified, appointment updated, and email sent",
      data: appointment,
    });
  } catch (error: any) {
    console.error(
      "[DEBUG] Verification error:",
      error.response?.data || error.message
    );
    return res.status(500).json({
      status: "failed",
      message: "Server error or verification failed",
    });
  }
});

export default router;
