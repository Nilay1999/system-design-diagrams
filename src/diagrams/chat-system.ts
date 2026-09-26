import { Diagram } from "./dsl";

export default function chatSystem() {
  return new Diagram("Chat System", "Stateful WebSocket servers + a message bus route messages between users on different servers")
    .zone("Stateful connection tier", 2, 0, 1, 4, "#2f9e44")
    .node("alice", "Alice (sender)", 0, 0, "client")
    .node("bob", "Bob (recipient)", 0, 3, "client")
    .node("lb", "L4/L7 LB (WebSocket)", 1, 1.5, "edge")
    .node("cs1", "Chat server A", 2, 0, "service")
    .node("cs2", "Chat server B", 2, 3, "service")
    .node("sessions", "Session & presence (Redis) user → server", 3, 1.5, "cache", { w: 1.1 })
    .node("db", "Message store (Cassandra) partition = conversation", 4.2, 0, "db", { w: 1.2, h: 1.2 })
    .node("bus", "Message bus (Kafka / Redis Pub/Sub)", 4.2, 1.6, "queue", { w: 1.2 })
    .node("push", "Push notification service", 4.2, 3, "worker")
    .node("apns", "APNs / FCM", 5.4, 3, "external")
    .edge("alice", "lb", "WS", { both: true })
    .edge("bob", "lb", "WS", { both: true })
    .edge("lb", "cs1")
    .edge("lb", "cs2")
    .edge("cs1", "db", "2. persist")
    .edge("cs1", "sessions", "3. where is Bob?")
    .edge("cs1", "bus", "4. publish", { async: true })
    .edge("bus", "cs2", "5. deliver to Bob", { async: true })
    .edge("cs2", "sessions", "heartbeat", { async: true })
    .edge("bus", "push", "Bob offline", { async: true })
    .edge("push", "apns")
    .steps(
      "Send path",
      [
        "Alice sends {client_msg_id, to, body}",
        "Server assigns msg_id, persists, ACKs Alice (✓)",
        "Look up Bob's connection server",
        "Publish to that server's inbox topic",
        "Server B pushes to Bob; Bob ACKs (✓✓)",
      ],
      5.7,
      -0.2,
    )
    .build();
}
