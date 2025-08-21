// src/index.ts
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

import qrRouter from "./api/qr";
import verificationRouter from "./api/verification";
import { connectDB } from "./config/mongo";
import servicesRouter from "./api/services";
import appointmentsRoute from "./api/appointments";
import appointmentAvailabilityRoutes from "./api/availability";

// Import workers so they start automatically

const app = express();

// Enable CORS
app.use(
  cors({
    origin: process.env.FRONTEND_URL, // now dynamic
    // origin: "http://localhost:3000", // now dynamic

    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
  })
);

// Parse JSON body
app.use(express.json());

// Routes
app.use("/qr", qrRouter);
app.use("/verify-slip", verificationRouter);
app.use("/services", servicesRouter);
app.use("/appointments", appointmentsRoute);
app.use("/availability", appointmentAvailabilityRoutes);
// app.use("/send-confirmation-email", sendConfirmationEmailRoute); // optional

// Connect to MongoDB, then start server
(async () => {
  try {
    await connectDB();

    const PORT = process.env.PORT || 3007;
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error("❌ Server startup failed:", err);
    process.exit(1);
  }
})();
