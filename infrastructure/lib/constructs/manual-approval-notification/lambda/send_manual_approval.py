import json
import os
import boto3
from slack import WebClient

codepipeline_client = boto3.client("codepipeline")


def _get_summary(stage_states: list) -> dict:
    state = stage_states[0]["actionStates"][0]
    summary = state["latestExecution"]["summary"]
    time = state["latestExecution"]["lastStatusChange"].strftime("%Y年%m月%d日%H時%m分")
    return {"summary": summary, "time": time}


def _get_token(stage_states: list) -> dict:
    state = stage_states[2]["actionStates"][0]
    token = state["latestExecution"]["token"]
    execution_id = state["latestExecution"]["actionExecutionId"]
    return {"token": token, "execution_id": execution_id}


def lambda_handler(event, _):
    token = os.environ["SLACK_API_TOKEN"]
    channel_id = os.environ["CHANNEL_ID"]
    codepipeline_name = os.environ["CODEPIPELINE_NAME"]

    client = WebClient(token=token)

    print(f"{event=}")
    message = event["Records"][0]["Sns"]["Message"]
    data = json.loads(message)
    execution_id_from_sns = data["detail"]["action-execution-id"]

    response = codepipeline_client.get_pipeline_state(name=codepipeline_name)
    latest_execution = {}
    latest_execution.update(_get_summary(response["stageStates"]))
    latest_execution.update(_get_token(response["stageStates"]))
    print(f"{execution_id_from_sns=}")
    print(f"{latest_execution=}")
    if execution_id_from_sns != latest_execution["execution_id"]:
        return {}

    messages = [
        f"対象コミット：`{latest_execution['summary']}`",
        f"対象コミット時刻：`{latest_execution['time']}`",
        "",
        "アクションを選んでください。",
    ]

    attachments_json = [
        {
            "fallback": "Upgrade your Slack client to use messages like these.",
            "color": "#258ab5",
            "attachment_type": "default",
            "callback_id": "codepipeline_manual_approval",
            "actions": [
                {
                    "action_id": "codepipeline_manual_approval_ok",
                    "name": "ok",
                    "text": "承認する",
                    "value": latest_execution["token"] + "," + codepipeline_name,
                    "style": "primary",
                    "type": "button",
                    "confirm": {"title": "承認しますか?", "text": "本当によろしいですか?", "ok_text": "OK", "dismiss_text": "Cancel"},
                },
                {
                    "action_id": "codepipeline_manual_approval_cancel",
                    "name": "cancel",
                    "text": "却下する",
                    "style": "danger",
                    "value": latest_execution["token"] + "," + codepipeline_name,
                    "type": "button",
                },
            ],
        }
    ]

    try:
        response = client.chat_postMessage(channel=channel_id, text="\n".join(messages), attachments=attachments_json)

        assert response["ok"]
    except Exception as e:
        print(e)
