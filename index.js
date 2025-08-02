const express = require("express");
require("dotenv").config();
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);
const cors = require("cors");
const bodyParser = require("body-parser");

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(bodyParser.json());

// mongodb setup
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("zapShift");
    const parcelsCollection = db.collection("parcels");
    const paymentsCollection = db.collection("payments");

    // 📨 Create parcel
    app.post("/parcels", async (req, res) => {
      try {
        const newParcel = req.body;
        const result = await parcelsCollection.insertOne(newParcel);
        res.status(201).send(result);
      } catch (error) {
        console.error("❌ Failed to create parcel:", error.message);
        res.status(500).send({
          message: "Something went wrong while saving parcel",
          error: error.message,
        });
      }
    });

    // 📦 Get all parcels
    app.get("/parcels", async (req, res) => {
      const parcels = await parcelsCollection.find().toArray();
      res.send(parcels);
    });

    // 📦 Get a parcel by ID
    app.get("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const parcel = await parcelsCollection.findOne(query);

        if (!parcel) {
          return res.status(404).json({ message: "Parcel not found" });
        }

        res.status(200).json(parcel);
      } catch (error) {
        console.error("❌ Error getting parcel by ID:", error);
        res.status(500).json({ message: "Internal Server Error" });
      }
    });

    // 🚫 Delete a parcel by _id
    app.delete("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await parcelsCollection.deleteOne(query);
        res.json(result);
      } catch (error) {
        console.error("❌ Error deleting parcel:", error);
        res.status(500).json({ message: "Internal Server Error" });
      }
    });

    // create payment intent
    app.post("/create-payment-intent", async (req, res) => {
      try {
        const { amountInCents, currency = "usd" } = req.body;

        // Create a PaymentIntent with the amount and currency
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountInCents,
          currency: currency,
          automatic_payment_methods: {
            enabled: true,
          },
        });

        // Send the client secret to the client
        console.log("PaymentIntent created:", paymentIntent.id);
        res.json({
          clientSecret: paymentIntent.client_secret,
        });
      } catch (error) {
        console.error("❌ Stripe error:", error.message);
        res.status(400).json({ error: error.message });
      }
    });

    // record payments and update parcel status
    app.post("/payments", async (req, res) => {
      try {
        const {
          parcelId,
          email,
          transactionId,
          amount,
          currency = "usd",
          paymentMethod,
        } = req.body;

        // 1. Insert payment into payments collection
        const paymentRecord = {
          parcelId: new ObjectId(parcelId),
          email,
          transactionId,
          amount,
          currency,
          paymentMethod,
          paid_at: new Date(),
          paid_at_string: new Date().toISOString(),
        };

        const paymentResult = await db
          .collection("payments")
          .insertOne(paymentRecord);

        // 2. Update the parcel as paid
        const updateResult = await db
          .collection("parcels")
          .updateOne(
            { _id: new ObjectId(parcelId) },
            { $set: { payment_status: "paid" } }
          );

        res.status(200).json({
          message: "Payment recorded and parcel marked as paid",
          insertedId: paymentResult.insertedId,
          updated: updateResult.modifiedCount,
        });
      } catch (error) {
        console.error("❌ Error recording payment:", error.message);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    app.get("/payments", async (req, res) => {
      try {
        const userEmail = req.query.email;

        const query = userEmail ? { email: userEmail } : {};
        const payments = await db
          .collection("payments")
          .find(query)
          .sort({ paid_at: -1 }) // descending
          .toArray();

        res.status(200).json(payments);
      } catch (error) {
        console.error("❌ Error getting payments:", error.message);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
