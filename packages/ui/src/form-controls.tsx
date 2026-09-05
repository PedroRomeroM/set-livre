import {
  cloneElement,
  useId,
  type ComponentPropsWithRef,
  type ReactElement,
  type ReactNode,
} from "react";

import styles from "./form-controls.module.css";

type FieldControlProps = {
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "false" | "grammar" | "spelling" | "true";
  "aria-required"?: boolean | "false" | "true";
  id?: string;
  required?: boolean;
};

export type FieldProps = {
  children: ReactElement<FieldControlProps>;
  controlId?: string;
  description?: ReactNode;
  error?: string;
  label: ReactNode;
  required?: boolean;
};

function joinIds(...ids: Array<string | undefined>): string | undefined {
  const joinedIds = ids.filter((id) => id !== undefined && id !== "").join(" ");
  return joinedIds === "" ? undefined : joinedIds;
}

function joinClassNames(...classNames: Array<string | undefined>): string {
  return classNames.filter((className) => className !== undefined && className !== "").join(" ");
}

export function Field({
  children,
  controlId,
  description,
  error,
  label,
  required = false,
}: FieldProps) {
  const generatedId = useId();
  const resolvedControlId = controlId ?? children.props.id ?? generatedId;
  const resolvedRequired = required || children.props.required === true;
  const descriptionId = description === undefined ? undefined : `${resolvedControlId}-description`;
  const errorId = error === undefined ? undefined : `${resolvedControlId}-error`;
  const describedBy = joinIds(children.props["aria-describedby"], descriptionId, errorId);
  const controlProps: FieldControlProps = {
    id: resolvedControlId,
  };

  if (describedBy !== undefined) {
    controlProps["aria-describedby"] = describedBy;
  }
  if (error !== undefined) {
    controlProps["aria-invalid"] = true;
  }
  if (resolvedRequired) {
    controlProps["aria-required"] = true;
    controlProps.required = true;
  }

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={resolvedControlId}>
        {label}
        {resolvedRequired ? (
          <span className={styles.required} aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {description === undefined ? null : (
        <p className={styles.description} id={descriptionId}>
          {description}
        </p>
      )}
      {cloneElement(children, controlProps)}
      {error === undefined ? null : (
        <p className={styles.error} id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export type InputProps = ComponentPropsWithRef<"input">;

export function Input({ className, ...inputProps }: InputProps) {
  return <input {...inputProps} className={joinClassNames(styles.input, className)} />;
}

export type SelectProps = ComponentPropsWithRef<"select">;

export function Select({ className, ...selectProps }: SelectProps) {
  return (
    <span className={styles.selectFrame}>
      <select {...selectProps} className={joinClassNames(styles.select, className)} />
      <span aria-hidden="true" className={styles.selectIndicator} />
    </span>
  );
}

export type TextareaProps = ComponentPropsWithRef<"textarea">;

export function Textarea({ className, ...textareaProps }: TextareaProps) {
  return <textarea {...textareaProps} className={joinClassNames(styles.textarea, className)} />;
}

export type CheckboxProps = Omit<ComponentPropsWithRef<"input">, "children" | "type"> & {
  description?: ReactNode;
  label: ReactNode;
};

export function Checkbox({
  "aria-describedby": ariaDescribedBy,
  className,
  description,
  id,
  label,
  ...inputProps
}: CheckboxProps) {
  const generatedId = useId();
  const resolvedId = id ?? generatedId;
  const descriptionId = description === undefined ? undefined : `${resolvedId}-description`;

  return (
    <label className={styles.checkboxLabel} htmlFor={resolvedId}>
      <input
        {...inputProps}
        aria-describedby={joinIds(ariaDescribedBy, descriptionId)}
        className={joinClassNames(styles.checkboxControl, className)}
        id={resolvedId}
        type="checkbox"
      />
      <span className={styles.checkboxCopy}>
        <span className={styles.checkboxText}>{label}</span>
        {description === undefined ? null : (
          <span className={styles.checkboxDescription} id={descriptionId}>
            {description}
          </span>
        )}
      </span>
    </label>
  );
}

export type ChoiceGroupValue = "company" | "individual";

type ChoiceGroupBaseProps = {
  className?: string;
  companyLabel?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  error?: string;
  individualLabel?: ReactNode;
  legend: ReactNode;
  name: string;
  required?: boolean;
};

type ControlledChoiceGroupProps = {
  defaultValue?: never;
  onValueChange: (value: ChoiceGroupValue) => void;
  value: ChoiceGroupValue;
};

type UncontrolledChoiceGroupProps = {
  defaultValue?: ChoiceGroupValue;
  onValueChange?: (value: ChoiceGroupValue) => void;
  value?: never;
};

export type ChoiceGroupProps = ChoiceGroupBaseProps &
  (ControlledChoiceGroupProps | UncontrolledChoiceGroupProps);

const choices: ReadonlyArray<{ defaultLabel: string; value: ChoiceGroupValue }> = [
  { defaultLabel: "Pessoa física", value: "individual" },
  { defaultLabel: "Pessoa jurídica", value: "company" },
];

type ChoiceSelectionProps = {
  checked?: boolean;
  defaultChecked?: boolean;
};

function choiceSelectionProps(
  choice: ChoiceGroupValue,
  value: ChoiceGroupValue | undefined,
  defaultValue: ChoiceGroupValue | undefined,
): ChoiceSelectionProps {
  if (value !== undefined) {
    return { checked: value === choice };
  }
  if (defaultValue !== undefined) {
    return { defaultChecked: defaultValue === choice };
  }
  return {};
}

export function ChoiceGroup({
  className,
  companyLabel,
  defaultValue,
  description,
  disabled = false,
  error,
  individualLabel,
  legend,
  name,
  onValueChange,
  required = false,
  value,
}: ChoiceGroupProps) {
  const generatedId = useId();
  const descriptionId = description === undefined ? undefined : `${generatedId}-description`;
  const errorId = error === undefined ? undefined : `${generatedId}-error`;
  const labels: Record<ChoiceGroupValue, ReactNode | undefined> = {
    company: companyLabel,
    individual: individualLabel,
  };

  return (
    <fieldset
      aria-describedby={joinIds(descriptionId, errorId)}
      aria-invalid={error === undefined ? undefined : true}
      className={joinClassNames(styles.choiceGroup, className)}
    >
      <legend className={styles.legend}>
        {legend}
        {required ? (
          <span className={styles.required} aria-hidden="true">
            *
          </span>
        ) : null}
      </legend>
      {description === undefined ? null : (
        <p className={styles.choiceDescription} id={descriptionId}>
          {description}
        </p>
      )}
      <div className={styles.choices}>
        {choices.map((choice) => (
          <label className={styles.choice} key={choice.value}>
            <input
              {...choiceSelectionProps(choice.value, value, defaultValue)}
              className={styles.choiceControl}
              disabled={disabled}
              name={name}
              onChange={onValueChange === undefined ? undefined : () => onValueChange(choice.value)}
              required={required}
              type="radio"
              value={choice.value}
            />
            <span className={styles.choiceLabel}>
              {labels[choice.value] ?? choice.defaultLabel}
            </span>
          </label>
        ))}
      </div>
      {error === undefined ? null : (
        <p className={joinClassNames(styles.error, styles.choiceError)} id={errorId} role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
