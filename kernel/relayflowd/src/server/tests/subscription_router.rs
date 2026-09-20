use super::*;

#[test]
fn targeted_router_verbs_validate_receipts_and_preserve_wire_metadata() {
    let directory = tempdir().unwrap();
    let hub = Arc::new(ProtocolHub::default());
    let run_id = start_llm_run(directory.path(), &hub);
    let (writer, _peer) = shared_writer();
    let call = |verb: &str, params: Value| {
        request(
            directory.path(),
            &hub,
            3,
            &writer,
            &json!({"id": "router", "verb": verb, "params": params}).to_string(),
        )
    };
    let receipt = json!({"binding_id":"a","generation":7});
    for name in ["a", "b"] {
        let response = call(
            "subscription.open",
            json!({"run_id":run_id,"subscription_id":name,
            "event_types":["github"],"settle_ms":0,"idle_ms":60000,"deadline_ms":120000,"include_self":false}),
        );
        assert!(response.ok, "{:?}", response.error);
        let response = call(
            "subscription.activate",
            json!({"run_id":run_id,"subscription_id":name,
            "ingress_offset":0,"router_binding":receipt}),
        );
        assert!(response.ok, "{:?}", response.error);
    }
    let mut delivery = json!({"run_id":run_id,"subscription_id":"a","router_binding":receipt,
        "delivery_id":"frame-1","frame":{"type":"github","payload":{"number":1}}});
    let response = call("subscription.deliver", delivery.clone());
    assert!(response.ok, "{:?}", response.error);
    assert_eq!(response.result.unwrap(), json!({"appended":true}));
    assert_eq!(
        call("subscription.deliver", delivery.clone())
            .result
            .unwrap(),
        json!({"appended":false,"reason":"duplicate"})
    );
    delivery["router_binding"]["generation"] = json!(8);
    let refused = call("subscription.deliver", delivery.clone());
    assert!(!refused.ok);
    assert_eq!(refused.error.unwrap().code, "subscription_binding_mismatch");
    let mismatched_activation = call(
        "subscription.activate",
        json!({"run_id":run_id,"subscription_id":"a",
        "ingress_offset":1,"router_binding":receipt}),
    );
    assert_eq!(
        mismatched_activation.error.unwrap().code,
        "subscription_binding_mismatch"
    );
    let snapshots = call("subscription.inspect", json!({"run_id":run_id}))
        .result
        .unwrap();
    assert_eq!(snapshots["subscriptions"][0]["unreadFrames"], 1);
    assert_eq!(snapshots["subscriptions"][1]["unreadFrames"], 0);
    assert!(snapshots["subscriptions"][0]["idleAtMs"].is_i64());
    let response = call(
        "subscription.fence_overflow",
        json!({"run_id":run_id,"subscription_id":"a","router_binding":receipt}),
    );
    assert!(response.ok, "{:?}", response.error);
    assert_eq!(response.result.unwrap(), json!({"fenced":true}));
    delivery["router_binding"] = receipt;
    assert_eq!(
        call("subscription.deliver", delivery).error.unwrap().code,
        "subscription_closed"
    );
    let snapshots = call("subscription.inspect", json!({"run_id":run_id}))
        .result
        .unwrap();
    assert_eq!(
        snapshots["subscriptions"][0]["completionReason"],
        "overflow"
    );
}
