import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/field.tsx";
import * as ButtonUI from "../../../src/components/ui/button.tsx";
import * as InputUI from "../../../src/components/ui/input.tsx";
import * as SelectUI from "../../../src/components/ui/select.tsx";
import * as SwitchUI from "../../../src/components/ui/switch.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Field</h1>
      <div className="grid w-full max-w-xl gap-5">
        <UI.FieldSet>
          <UI.FieldLegend>Session defaults</UI.FieldLegend>
          <UI.FieldGroup>
            <UI.Field>
              <UI.FieldLabel htmlFor="model">Default model</UI.FieldLabel>
              <SelectUI.Select defaultValue="sonnet">
                <SelectUI.SelectTrigger id="model">
                  <SelectUI.SelectValue />
                </SelectUI.SelectTrigger>
                <SelectUI.SelectContent>
                  <SelectUI.SelectItem value="sonnet">
                    Claude Sonnet
                  </SelectUI.SelectItem>
                  <SelectUI.SelectItem value="opus">
                    Claude Opus
                  </SelectUI.SelectItem>
                </SelectUI.SelectContent>
              </SelectUI.Select>
              <UI.FieldDescription>
                Used when a new session does not choose a model.
              </UI.FieldDescription>
            </UI.Field>
            <UI.Field orientation="horizontal">
              <SwitchUI.Switch id="approval" defaultChecked />
              <UI.FieldContent>
                <UI.FieldLabel htmlFor="approval">
                  Ask before risky commands
                </UI.FieldLabel>
                <UI.FieldDescription>
                  Review commands that modify files.
                </UI.FieldDescription>
              </UI.FieldContent>
            </UI.Field>
            <UI.Field data-invalid="true">
              <UI.FieldLabel htmlFor="alias">Workspace name</UI.FieldLabel>
              <InputUI.Input id="alias" aria-invalid />
              <UI.FieldError>Enter a workspace name.</UI.FieldError>
            </UI.Field>
          </UI.FieldGroup>
        </UI.FieldSet>
        <UI.FieldSeparator>or connect a provider</UI.FieldSeparator>
        <ButtonUI.Button variant="outline">Add provider</ButtonUI.Button>
      </div>
    </main>
  );
}

const meta = { title: "UI/Field", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
