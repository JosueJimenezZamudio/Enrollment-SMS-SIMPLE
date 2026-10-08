package com.enrollmentdesk.enrollmentsms;

import org.json.JSONObject;

final class OutboxMessage {
    final String id;
    final String phone;
    final String body;
    final JSONObject metadata;

    OutboxMessage(String id, String phone, String body, JSONObject metadata) {
        this.id = id;
        this.phone = phone;
        this.body = body;
        this.metadata = metadata == null ? new JSONObject() : metadata;
    }
}
