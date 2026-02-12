import "dotenv/config";

const RAILWAY_GRAPHQL_ENDPOINT = "https://backboard.railway.com/graphql/v2";
const RAILWAY_TEAM_TOKEN = process.env.RAILWAY_TOKEN;
const RAILWAY_PROJECT_ID = process.env.RAILWAY_PROJECT_ID;
const RAILWAY_ENVIRONMENT_ID = process.env.RAILWAY_ENVIRONMENT_ID;
const RAILWAY_SERVICE_ID = process.env.RAILWAY_SERVICE_ID;

if (!RAILWAY_TEAM_TOKEN || !RAILWAY_PROJECT_ID || !RAILWAY_ENVIRONMENT_ID || !RAILWAY_SERVICE_ID) {
  console.warn(
    "⚠️ [RailwayApi] Faltan variables de entorno de Railway: RAILWAY_TOKEN, RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID o RAILWAY_SERVICE_ID. Algunas funciones del dashboard no estarán disponibles."
  );
}

interface DeploymentNode {
  id: string;
  staticUrl?: string;
  createdAt?: string;
  status?: string;
}

interface DeploymentResponse {
  data?: {
    deployments?: {
      edges?: Array<{ node: DeploymentNode }>;
    };
  };
  errors?: Array<{ message: string; traceId?: string }>;
}

export class RailwayApi {
  /**
   * Obtiene el ID del deployment activo de un proyecto Railway
   */
  static async getActiveDeploymentId(): Promise<string | null> {
    const query = `
      query deployments(
        $projectId: String!,
        $environmentId: String!,
        $serviceId: String!
      ) {
        deployments(
          first: 1,
          input: {
            projectId: $projectId,
            environmentId: $environmentId,
            serviceId: $serviceId
          }
        ) {
          edges {
            node {
              id
              staticUrl
              createdAt
              status
            }
          }
        }
      }
    `;

    const variables = {
      projectId: RAILWAY_PROJECT_ID,
      environmentId: RAILWAY_ENVIRONMENT_ID,
      serviceId: RAILWAY_SERVICE_ID,
    };

    const body = JSON.stringify({ query, variables });

    console.log("[RailwayApi] Request getActiveDeploymentId:", body);

    const res = await fetch(RAILWAY_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${RAILWAY_TEAM_TOKEN}`,
      },
      body,
    });

    const data: DeploymentResponse = await res.json();
    console.log("[RailwayApi] Response getActiveDeploymentId:", JSON.stringify(data, null, 2));

    if (data.errors?.length) {
      console.error("Error desde Railway API:", data.errors);
      return null;
    }

    const deployment = data?.data?.deployments?.edges?.[0]?.node;
    if (!deployment?.id) {
      console.error("No se encontró ningún deployment activo.");
      return null;
    }

    console.log("[RailwayApi] Deployment activo encontrado:", deployment.id);
    return deployment.id;
  }

  /**
   * Obtiene las variables de entorno del servicio en Railway
   */
  static async getVariables(): Promise<Record<string, string> | null> {
    const query = `
      query variables($projectId: String!, $environmentId: String!, $serviceId: String!) {
        variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
      }
    `;

    const variables = {
      projectId: RAILWAY_PROJECT_ID,
      environmentId: RAILWAY_ENVIRONMENT_ID,
      serviceId: RAILWAY_SERVICE_ID,
    };

    try {
      const res = await fetch(RAILWAY_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${RAILWAY_TEAM_TOKEN}`,
        },
        body: JSON.stringify({ query, variables }),
      });

      const data = await res.json();
      if (data.errors?.length) {
        console.error("[RailwayApi] Error obteniendo variables:", data.errors);
        return null;
      }

      const allVariables = data?.data?.variables || {};
      // Filtrar para no exponer variables internas de Railway al frontend
      const filteredVariables: Record<string, string> = {};
      Object.keys(allVariables).forEach(key => {
        if (!key.startsWith('RAILWAY_')) {
          filteredVariables[key] = allVariables[key];
        }
      });

      return filteredVariables;
    } catch (err) {
      console.error("[RailwayApi] Error en getVariables:", err);
      return null;
    }
  }

  /**
   * Actualiza las variables de entorno en Railway de forma masiva para generar un solo deploy
   */
  static async updateVariables(newVariables: Record<string, string>): Promise<{ success: boolean; error?: string }> {
    const filteredVariables: Record<string, string> = {};
    const keys = Object.keys(newVariables).filter(key => {
      if (!key.startsWith('RAILWAY_')) {
        filteredVariables[key] = newVariables[key];
        return true;
      }
      return false;
    });

    if (keys.length === 0) return { success: true };

    const mutation = `
      mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) {
        variableCollectionUpsert(input: $input)
      }
    `;

    const variables = {
      input: {
        projectId: RAILWAY_PROJECT_ID,
        environmentId: RAILWAY_ENVIRONMENT_ID,
        serviceId: RAILWAY_SERVICE_ID,
        variables: filteredVariables
      }
    };

    try {
      const res = await fetch(RAILWAY_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${RAILWAY_TEAM_TOKEN}`,
        },
        body: JSON.stringify({ query: mutation, variables }),
      });

      const data = await res.json();
      if (data.errors?.length) {
        console.error("[RailwayApi] Error en mutation masiva:", JSON.stringify(data.errors, null, 2));
        const errorMsg = data.errors.map((e: any) => e.message).join("; ");
        return { success: false, error: errorMsg };
      }

      return { success: true };
    } catch (err: any) {
      console.error("[RailwayApi] Error en updateVariables masivo:", err);
      return { success: false, error: err.message };
    }
  }

  /**
   * Reinicia el deployment activo de Railway
   */
  static async restartActiveDeployment(): Promise<{ success: boolean; error?: string }> {
    try {
      const deploymentId = await this.getActiveDeploymentId();
      if (!deploymentId) {
        return { success: false, error: "No se encontró deployment activo para el proyecto." };
      }

      console.log("[RailwayApi] Reiniciando deployment:", deploymentId);

      const mutation = `
        mutation deploymentRestart($id: String!) {
          deploymentRestart(id: $id)
        }
      `;

      const body = JSON.stringify({
        query: mutation,
        variables: { id: deploymentId },
      });

      const res = await fetch(RAILWAY_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${RAILWAY_TEAM_TOKEN}`,
        },
        body,
      });

      const data = await res.json();
      console.log("[RailwayApi] Response restartActiveDeployment:", JSON.stringify(data, null, 2));

      if (data.errors?.length) {
        const errorMsg = data.errors.map((e: any) => e.message).join("; ");
        return { success: false, error: errorMsg };
      }

      return { success: true };
    } catch (err: any) {
      console.error("[RailwayApi] Error reiniciando deployment:", err);
      return { success: false, error: err.message };
    }
  }
}
