import { Router, Request, Response } from "express";
import axios from "axios";
import Appointment from "../models/Appointment";
import { sendEmail } from "../services/emailService";

const router = Router();

// Helper to normalize names for comparison
const normalizeName = (name: string): string => {
  return name
    .replace(/^(mr|mrs|ms|dr)\.?/i, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .trim();
};

router.post("/", async (req: Request, res: Response) => {
  try {
    const { bookingID, refNbr, amount } = req.body;

    if (!bookingID || !refNbr || !amount) {
      return res
        .status(400)
        .json({ status: "failed", message: "Missing required fields" });
    }

    const token = process.env.OPEN_SLIP_VERIFY_TOKEN;
    const expectedReceiverName = process.env.PROMPTPAY_RECEIVER_NAME;

    if (!token || !expectedReceiverName) {
      return res
        .status(500)
        .json({ status: "failed", message: "Server misconfiguration" });
    }

    // Check if this refNbr has already been used
    const existingAppointment = await Appointment.findOne({
      "paymentVerification.decodedString": refNbr,
    });
    if (existingAppointment) {
      return res
        .status(409)
        .json({ status: "failed", message: "Reference number already used" });
    }

    // Call the external OpenSlipVerify API
    const response = await axios.post(
      "https://api.openslipverify.com/v1/verify",
      { refNbr, amount, token },
      { headers: { "Content-Type": "application/json" } }
    );

    if (response.data?.success !== true) {
      return res.status(400).json({
        status: "failed",
        message: response.data?.statusMessage || "Verification unsuccessful",
      });
    }

    // Verify the receiver's name
    const receiver = response.data?.data?.receiver;
    const normalizedExpectedName = normalizeName(expectedReceiverName);
    const normalizedReturnedName = normalizeName(receiver?.name || "");

    if (normalizedExpectedName !== normalizedReturnedName) {
      return res.status(400).json({
        status: "failed",
        message: "Receiver account mismatch",
        debug: {
          expected: normalizedExpectedName,
          got: normalizedReturnedName,
        },
      });
    }

    // Find appointment by bookingID
    const appointment = await Appointment.findOne({ bookingId: bookingID });
    if (!appointment) {
      return res
        .status(404)
        .json({ status: "failed", message: "Appointment not found" });
    }

    // Update appointment verification status
    appointment.paymentVerification = {
      status: "verified",
      verifiedAt: new Date(),
      decodedString: refNbr,
      notes: response.data.statusMessage || null,
    };
    await appointment.save();

    // Send confirmation email
    try {
      const { userDetails, timeSlot, amount } = appointment;
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
      console.log(`Confirmation email sent for booking ${bookingID}`);
    } catch (emailError) {
      console.error(
        `Failed to send email for booking ${bookingID}:`,
        emailError
      );
    }

    return res.json({
      status: "verified", // frontend expects "verified"
      message: "Slip verified, appointment updated, and email sent",
      data: appointment,
    });
  } catch (error: any) {
    console.error("Verification error:", error.response?.data || error.message);
    return res.status(500).json({
      status: "failed",
      message: "Server error or verification failed",
    });
  }
});

export default router;
