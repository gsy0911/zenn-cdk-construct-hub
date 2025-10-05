import {
  aws_iam,
  aws_lambda,
  aws_codepipeline,
  aws_sns,
  aws_sns_subscriptions,
  SecretValue,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { PythonFunction } from "@aws-cdk/aws-lambda-python-alpha";
import * as path from "path"

interface IBackendPipelineStack {
  pipeline: aws_codepipeline.IPipeline
  serviceName: string
  secretManager: {
    /**
     * GitHubへアクセスするTokenを保管している SecretManagerのARN
     * stgとprodで共通
     * */
    gitTokenARN: "GitHub";
    /** mapping key name */
    gitTokenJsonField: "GitHubToken";
    slackTokenArn: "Slack";
    slackTokenJsonField: "BotUserOAuthToken";
  };
  slack: {
    channelId: `C${string}`;
  };
}

export class ManualApprovalNotification extends Construct {
  constructor(
    scope: Construct,
    id: string,
    props: IBackendPipelineStack,
  ) {
    super(scope, id);

    const { pipeline, serviceName } = props;

    /** Lambdaに付与するロール */
    const lambdaRole = new aws_iam.Role(this, "lambda-role", {
      roleName: `${serviceName}-pipeline-lambda-role`,
      assumedBy: new aws_iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        aws_iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          "lambdaCloudWatchFullAccess",
          "arn:aws:iam::aws:policy/AWSOpsWorksCloudWatchLogs",
        ),
      ],
    });

    const approvalTopic = new aws_sns.Topic(this, "pipeline-approval-topic", {
      topicName: `${serviceName}-pipeline-approval-topic`,
    });
    // slackのtokenをSecretsManagerから取得する
    const slackToken = SecretValue.secretsManager(
      props.secretManager.slackTokenArn,
      {
        jsonField: props.secretManager.slackTokenJsonField,
      },
    );
    /**
     * CodePipelineの承認を通知するLambda
     * 結果を受け取る処理は`ChatOpsStack`に作成している。
     * （すでにAPI Gatewayなども構築されているため）
     * */
    const lambdaSendManualApproval = new PythonFunction(
      this,
      "lambda-send-manual-approval",
      {
        functionName: `${serviceName}-lambda-send-manual-approval`,
        entry: `${path.resolve(__dirname)}/lambda`,
        index: "send_manual_approval.py",
        handler: "lambda_handler",
        runtime: aws_lambda.Runtime.PYTHON_3_12,
        environment: {
          SLACK_API_TOKEN: slackToken.unsafeUnwrap(),
          CHANNEL_ID: props.slack.channelId,
          CODEPIPELINE_NAME: pipeline.pipelineName,
          TZ: "Asia/Tokyo",
        },
        role: lambdaRole,
      },
    );
    approvalTopic.addSubscription(
      new aws_sns_subscriptions.LambdaSubscription(lambdaSendManualApproval),
    );
    pipeline.notifyOnAnyManualApprovalStateChange(
      "notify-approval-topic",
      approvalTopic,
      {
        notificationRuleName: `${serviceName}-backend-pipeline-approval-notification`,
      },
    );

  }
}
