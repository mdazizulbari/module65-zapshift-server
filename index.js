const express = require("express");
require("dotenv").config();
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);
const cors = require("cors");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(bodyParser.json());

// firebase
const serviceAccount = require("./firebaseAdmin-key.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

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
    const trackingCollection = db.collection("tracks");
    const usersCollection = db.collection("users");
    const ridersCollection = db.collection("riders");

    // custom middlewares
    const verifyFBToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).send({ message: "Unauthorized access" });
      }
      const token = authHeader.split(" ")[1];
      if (!token) {
        return res.status(401).send({ message: "Unauthorized access" });
      }

      // verify the token
      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        return res.status(403).send({ message: "Forbidden access" });
      }
    };

    // add users in usersCollection
    app.post("/users", async (req, res) => {
      const email = req.body.email;
      const userExists = await usersCollection.findOne({ email });
      if (userExists) {
        // update last login
        return res
          .status(200)
          .send({ message: "User already exists", inserted: false });
      }
      const user = req.body;
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

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
    // app.get("/parcels", async (req, res) => {
    //   const parcels = await parcelsCollection.find().toArray();
    //   res.send(parcels);
    // });

    // GET: All parcels OR parcels by user userEmail, sorted by latest
    app.get("/parcels", verifyFBToken, async (req, res) => {
      try {
        const userEmail = req.query.email;

        console.log(req.headers);
        const query = userEmail ? { userEmail } : {};
        const options = {
          sort: { creation_date: -1 }, // Newest first
        };

        const parcels = await parcelsCollection.find(query, options).toArray();
        res.send(parcels);
      } catch (error) {
        console.error("Error fetching parcels:", error);
        res.status(500).send({ message: "Failed to get parcels" });
      }
    });

    // GET: Get a specific parcel by ID
    app.get("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;

        const parcel = await parcelsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!parcel) {
          return res.status(404).send({ message: "Parcel not found" });
        }

        res.send(parcel);
      } catch (error) {
        console.error("Error fetching parcel:", error);
        res.status(500).send({ message: "Failed to fetch parcel" });
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

    // adding a rider
    app.post("/riders", async (req, res) => {
      const rider = req.body;
      const result = await ridersCollection.insertOne(rider);
      res.send(result);
    });

    // Get all riders with pending status
    app.get("/riders/pending", async (req, res) => {
      try {
        const pendingList = await ridersCollection
          .find({ status: "pending" })
          .sort({ _id: -1 }) // Newest first
          .toArray();

        res.status(200).json(pendingList);
      } catch (err) {
        console.error("❌ Error fetching pending riders:", err);
        res.status(500).json({ message: "Internal Server Error" });
      }
    });

    // Get all riders with active status
    app.get("/riders/active", async (req, res) => {
      try {
        const activeList = await ridersCollection
          .find({ status: "active" })
          .sort({ _id: -1 })
          .toArray();

        res.status(200).json(activeList);
      } catch (err) {
        console.error("❌ Error fetching active riders:", err);
        res.status(500).json({ message: "Internal Server Error" });
      }
    });

    app.patch("/riders/:id/approve", async (req, res) => {
      await ridersCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { status: "active" } }
      );
      res.send({ success: true });
    });

    app.patch("/riders/:id/reject", async (req, res) => {
      await ridersCollection.deleteOne({ _id: new ObjectId(req.params.id) });
      res.send({ success: true });
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

        const paymentResult = await paymentsCollection.insertOne(paymentRecord);

        // 2. Update the parcel as paid
        const updateResult = await parcelsCollection.updateOne(
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

    // getting the payments by email or all for admin
    app.get("/payments", verifyFBToken, async (req, res) => {
      console.log("Headers in payment", req.headers);

      try {
        const userEmail = req.query.email;
        console.log("decoded", req.decoded);
        if (req.decoded.email !== userEmail) {
          return res.status(405).send({ message: "Forbidden access" });
        }

        const query = userEmail ? { email: userEmail } : {};
        const payments = await paymentsCollection
          .find(query)
          .sort({ paid_at: -1 }) // descending
          .toArray();

        res.status(200).json(payments);
      } catch (error) {
        console.error("❌ Error getting payments:", error.message);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // adding a tracking
    app.post("/tracking", async (req, res) => {
      const {
        tracking_id,
        parcel_id,
        status,
        message,
        updated_by = "",
      } = req.body;
      const log = {
        tracking_id,
        parcel_id: parcel_id ? new ObjectId(parcel_id) : undefined,
        status,
        message,
        updated_by,
        time: new Date(),
      };

      const result = await trackingCollection.insertOne(log);
      res.send({ success: true, insertedId: result.insertedId });
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
