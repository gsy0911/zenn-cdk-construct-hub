import {
  aws_iam,
  aws_lambda,
  aws_secretsmanager,
  aws_apigateway,
  Duration,
  SecretValue,
} from "aws-cdk-lib";
import { Construct } from "constructs";

import { PythonFunction } from "@aws-cdk/aws-lambda-python-alpha";

interface IChatOpsStack {
  secretsManager: {
    arn: string;
  };
  source: {
    git: {
      /** git owner name */
      owner: string;
      /** git repository name */
      repositoryName: string;
      /** git repository name */
      branch: string;
    };
  };
}


export class ChatOps extends Construct {
  constructor(
    scope: Construct,
    id: string,
    params: IChatOpsStack,
  ) {
    super(scope, id);

    // slackのtokenをSecretsManagerから取得する
    const secretCompleteArn = params.secretsManager.arn;
    const slackSecretFromCompleteArn =
      aws_secretsmanager.Secret.fromSecretCompleteArn(
        this,
        "SecretFromCompleteArn",
        secretCompleteArn,
      );
    const secrets = slackSecretFromCompleteArn.secretValue.toString();
    // const view_response_channel = "#raund_develop"
    const view_response_channel = "#deployprod";

    const lambdaRole = new aws_iam.Role(this, "lambdaRole", {
      roleName: "raund-chatops-lambda-role",
      assumedBy: new aws_iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        aws_iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          "lambdaCW",
          "arn:aws:iam::aws:policy/CloudWatchFullAccessV2",
        ),
        aws_iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          "lambdaLambda",
          "arn:aws:iam::aws:policy/service-role/AWSLambdaRole",
        ),
        aws_iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          "lambdaS3",
          "arn:aws:iam::aws:policy/AmazonS3FullAccess",
        ),
        aws_iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          "lambdaSFn",
          "arn:aws:iam::aws:policy/AWSStepFunctionsFullAccess",
        ),
        aws_iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          "lambdaCodeBuild",
          "arn:aws:iam::aws:policy/AWSCodeBuildAdminAccess",
        ),
        aws_iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          "lambdaEventBridge",
          "arn:aws:iam::aws:policy/AmazonEventBridgeFullAccess",
        ),
        aws_iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          "lambdaCodePipelineApproval",
          "arn:aws:iam::aws:policy/AWSCodePipelineApproverAccess",
        ),
      ],
    });

    /** ChatOpsの起点となるLambda */
    const lambdaSlackApplication = new PythonFunction(
      this,
      "lambda-slack-application",
      {
        functionName: `raundSlackApplication`,
        entry: "./lib/lambda/chatops_stack",
        index: "lambda_function.py",
        handler: "slack_app_handler",
        runtime: aws_lambda.Runtime.PYTHON_3_11,
        memorySize: 256,
        timeout: Duration.seconds(30),
        role: lambdaRole,
        environment: {
          SECRETS_VALUES: secrets,
          VIEW_RESPONSE_CHANNEL: view_response_channel,
        },
      },
    );

    const integrationSlackApplication = new aws_apigateway.LambdaIntegration(
      lambdaSlackApplication,
    );

    const api = new aws_apigateway.RestApi(this, "slack_apis", {
      restApiName: "raund_slack_endpoint",
      defaultIntegration: integrationSlackApplication,
      deployOptions: {
        stageName: "v1",
      },
    });

    const interactiveRoot = api.root.addResource("application");
    interactiveRoot.addMethod("POST", integrationSlackApplication);

  }
}
